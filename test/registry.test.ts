import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  CORE_BOOTSTRAP_INVENTORY,
  InMemoryRegistryPersistence,
  OwnershipConflictError,
  RegistryContractError,
  RegistryService,
  bootstrapCoreInventory,
  parseCapabilityId,
  type RegistryRegisterInput,
} from '../src/domain/registry/index.js'
import * as registryPlugin from '../src/plugins/registry-plugin.js'

function candidate(overrides: Partial<RegistryRegisterInput> = {}): RegistryRegisterInput {
  return {
    owner: 'generated/matter-home',
    version: '0.1.0',
    provenance: { kind: 'generated', origin: 'assistant' },
    evidence: 'Implemented',
    capabilities: [{ id: 'matter.light.set', permissions: ['local.matter.control'] }],
    runtimeSeams: ['integrations.home'],
    ...overrides,
  }
}

function registry(persistence = new InMemoryRegistryPersistence()) {
  return new RegistryService(persistence)
}

describe('capability identity', () => {
  it('accepts stable dotted identities and rejects malformed ones', () => {
    assert.equal(parseCapabilityId('calendar.read'), 'calendar.read')
    assert.equal(parseCapabilityId('matter.light.set'), 'matter.light.set')
    assert.throws(() => parseCapabilityId('Calendar.Read'), RegistryContractError)
    assert.throws(() => parseCapabilityId('calendar'), RegistryContractError)
    assert.throws(() => parseCapabilityId('calendar.'), RegistryContractError)
    assert.throws(() => parseCapabilityId(''), RegistryContractError)
  })
})

describe('capability registry', () => {
  it('registers, looks up, and filters records', () => {
    const store = registry()
    store.register(candidate())
    store.register(candidate({
      owner: 'managed/personal-memory',
      version: '0.1.0',
      provenance: { kind: 'managed', origin: 'human' },
      status: 'active',
      capabilities: [{ id: 'memory.read', permissions: [] }],
      runtimeSeams: ['memory'],
    }))
    assert.equal(store.get('generated/matter-home', '0.1.0')?.status, 'candidate')
    assert.deepEqual(
      store.list({ status: 'candidate' }).map((item) => item.owner),
      ['generated/matter-home'],
    )
    assert.equal(store.list({ capability: 'memory.read' }).length, 1)
    assert.deepEqual(store.listCapabilities('managed/personal-memory', '0.1.0'), ['memory.read'])
  })

  it('resolves the active owner and keeps unknown distinct from inactive', () => {
    const store = registry()
    store.register(candidate({
      owner: 'managed/integrations',
      version: '1.0.0',
      provenance: { kind: 'managed', origin: 'human' },
      status: 'active',
      capabilities: [{ id: 'calendar.read', permissions: ['local.fake.calendar.read'] }],
      runtimeSeams: ['integrations.calendar'],
      provider: 'fake',
    }))
    const owned = store.resolveActiveOwner('calendar.read')
    assert.equal(owned.kind, 'owner')
    if (owned.kind === 'owner') {
      assert.equal(owned.record.owner, 'managed/integrations')
      assert.equal(owned.record.provider, 'fake')
    }
    assert.equal(store.resolveActiveOwner('matter.light.set').kind, 'unknown')
    store.transitionStatus('managed/integrations', '1.0.0', 'disabled')
    const inactive = store.resolveActiveOwner('calendar.read')
    assert.equal(inactive.kind, 'inactive')
  })

  it('rejects conflicting active owners instead of picking one', () => {
    const store = registry()
    store.register(candidate({
      owner: 'managed/integrations',
      version: '1.0.0',
      provenance: { kind: 'managed', origin: 'human' },
      status: 'active',
      capabilities: [{ id: 'calendar.read', permissions: [] }],
      runtimeSeams: ['integrations.calendar'],
    }))
    assert.throws(() => store.register(candidate({
      owner: 'generated/calendar-v2',
      version: '1.0.0',
      status: 'active',
      capabilities: [{ id: 'calendar.read', permissions: [] }],
      runtimeSeams: ['integrations.calendar'],
    })), OwnershipConflictError)
    assert.equal(store.conflicts().length, 0)
    assert.equal(store.resolveActiveOwner('calendar.read').kind, 'owner')
  })

  it('keeps a candidate version beside the active version of the same owner', () => {
    const store = registry()
    store.register(candidate({
      owner: 'managed/integrations',
      version: '1.0.0',
      provenance: { kind: 'managed', origin: 'human' },
      status: 'active',
      capabilities: [{ id: 'calendar.read', permissions: ['local.fake.calendar.read'] }],
      runtimeSeams: ['integrations.calendar'],
    }))
    store.register(candidate({
      owner: 'managed/integrations',
      version: '1.1.0',
      provenance: { kind: 'managed', origin: 'human' },
      capabilities: [
        { id: 'calendar.read', permissions: ['local.fake.calendar.read'] },
        { id: 'calendar.write', permissions: ['local.fake.calendar.write'] },
      ],
      runtimeSeams: ['integrations.calendar'],
    }))
    assert.equal(store.get('managed/integrations', '1.0.0')?.status, 'active')
    assert.equal(store.get('managed/integrations', '1.1.0')?.status, 'candidate')
    assert.equal(store.get('managed/integrations', '1.1.0')?.approval, 'unreviewed')
    assert.equal(store.get('managed/integrations', '1.0.0')?.approval, 'unreviewed')
    assert.equal(store.resolveActiveOwner('calendar.read').kind, 'owner')
    const write = store.resolveActiveOwner('calendar.write')
    assert.equal(write.kind, 'inactive')
  })

  it('does not infer approval when a successor asks for more permissions', () => {
    const store = registry()
    store.register(candidate({
      owner: 'managed/integrations',
      version: '1.0.0',
      provenance: { kind: 'managed', origin: 'human' },
      status: 'active',
      capabilities: [{ id: 'calendar.read', permissions: ['local.fake.calendar.read'] }],
      runtimeSeams: ['integrations.calendar'],
    }))
    const next = store.register(candidate({
      owner: 'managed/integrations',
      version: '1.1.0',
      provenance: { kind: 'managed', origin: 'human' },
      capabilities: [{
        id: 'calendar.read',
        permissions: ['local.fake.calendar.read', 'local.fake.calendar.write'],
      }],
      runtimeSeams: ['integrations.calendar'],
    }))
    assert.equal(next.approval, 'unreviewed')
    assert.equal(store.get('managed/integrations', '1.0.0')?.approval, 'unreviewed')
  })

  it('cannot manufacture approved-for-this-diff through register', () => {
    const store = registry()
    const recorded = store.register({
      ...candidate(),
      approval: 'approved-for-this-diff',
    } as RegistryRegisterInput & { approval: 'approved-for-this-diff' })
    assert.equal(recorded.approval, 'unreviewed')
    assert.equal(store.get('generated/matter-home', '0.1.0')?.approval, 'unreviewed')
  })

  it('round-trips through a replaceable in-memory persistence adapter', () => {
    const persistence = new InMemoryRegistryPersistence()
    const first = registry(persistence)
    first.register(candidate({ status: 'candidate' }))
    const second = registry(persistence)
    assert.equal(second.get('generated/matter-home', '0.1.0')?.evidence, 'Implemented')
    second.transitionStatus('generated/matter-home', '0.1.0', 'disabled')
    const third = registry(persistence)
    assert.equal(third.get('generated/matter-home', '0.1.0')?.status, 'disabled')
    assert.equal(third.get('generated/matter-home', '0.1.0')?.approval, 'unreviewed')
  })

  it('rejects malformed persisted snapshots instead of promoting them to domain records', () => {
    assert.throws(
      () => new RegistryService(new InMemoryRegistryPersistence([{ owner: 'managed/integrations', capabilities: [{ id: 'Calendar.Read' }] }])),
      RegistryContractError,
    )
  })

  it('rejects conflicting active owners in persisted data', () => {
    const row = {
      owner: 'managed/integrations',
      version: '1.0.0',
      provenance: { kind: 'managed', origin: 'human' },
      status: 'active',
      evidence: 'Verified',
      approval: 'unreviewed',
      capabilities: [{ id: 'calendar.read', permissions: [] }],
      permissions: [],
      runtimeSeams: ['integrations.calendar'],
      tools: [],
      services: [],
      providers: [],
    }
    assert.throws(
      () => new RegistryService(new InMemoryRegistryPersistence([
        row,
        { ...row, owner: 'generated/calendar-v2', provenance: { kind: 'generated', origin: 'assistant' } },
      ])),
      OwnershipConflictError,
    )
  })

  it('records stored approval evidence without letting register copy it onto a successor', () => {
    const persistence = new InMemoryRegistryPersistence([{
      owner: 'managed/integrations',
      version: '1.0.0',
      provenance: { kind: 'managed', origin: 'human' },
      status: 'active',
      evidence: 'Verified',
      approval: 'approved-for-this-diff',
      capabilities: [{ id: 'calendar.read', permissions: ['local.fake.calendar.read'] }],
      permissions: [],
      runtimeSeams: ['integrations.calendar'],
      tools: [],
      services: [],
      providers: [],
    }])
    const store = registry(persistence)
    assert.equal(store.get('managed/integrations', '1.0.0')?.approval, 'approved-for-this-diff')
    const next = store.register(candidate({
      owner: 'managed/integrations',
      version: '1.1.0',
      provenance: { kind: 'managed', origin: 'human' },
      capabilities: [{
        id: 'calendar.read',
        permissions: ['local.fake.calendar.read', 'local.fake.calendar.write'],
      }],
      runtimeSeams: ['integrations.calendar'],
    }))
    assert.equal(next.approval, 'unreviewed')
    assert.equal(store.get('managed/integrations', '1.0.0')?.approval, 'approved-for-this-diff')
  })

  it('bootstraps a conservative Core MVP inventory without live vendors', () => {
    const store = registry()
    bootstrapCoreInventory((input) => store.register(input))
    assert.equal(store.list({ status: 'active' }).length, CORE_BOOTSTRAP_INVENTORY.length)
    assert.equal(store.resolveActiveOwner('calendar.read').kind, 'owner')
    assert.equal(store.resolveActiveOwner('memory.write').kind, 'owner')
    assert.equal(store.resolveActiveOwner('policy.confirm').kind, 'owner')
    const calendar = store.resolveActiveOwner('calendar.read')
    assert.equal(calendar.kind, 'owner')
    if (calendar.kind === 'owner') {
      assert.equal(calendar.record.provider, 'fake')
      assert.equal(calendar.record.owner, 'managed/integrations')
    }
    const serialized = JSON.stringify(store.list())
    assert.equal(serialized.includes('google'), false)
    assert.equal(store.resolveActiveOwner('matter.light.set').kind, 'unknown')
  })
})

describe('capability registry plugin', () => {
  it('exposes a public service and read-only lookup tools', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    const fiber = ctx.plugin(registryPlugin)
    await fiber
    try {
      assert.ok(ctx.capabilityRegistry)
      assert.equal(ctx.capabilityRegistry.resolveActiveOwner('knowledge.retrieve').kind, 'owner')
      assert.ok(ctx.tools.get('list_capabilities'))
      assert.ok(ctx.tools.get('lookup_capability'))
      const listed = await ctx.tools.execute({
        callId: CallId('test-list-capabilities'),
        name: 'list_capabilities',
        arguments: { capability: 'ui.control' },
        signal: AbortSignal.timeout(5000),
      })
      assert.equal(listed.isError, false)
      assert.match(String(listed.value), /managed\/ui-control-surface/)
      const lookup = await ctx.tools.execute({
        callId: CallId('test-lookup-capability'),
        name: 'lookup_capability',
        arguments: { capability: 'jobs.run' },
        signal: AbortSignal.timeout(5000),
      })
      assert.equal(lookup.isError, false)
      assert.match(String(lookup.value), /"kind":"owner"/)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
