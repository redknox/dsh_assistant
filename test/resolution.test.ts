import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  InMemoryRegistryPersistence,
  RegistryService,
  bootstrapCoreInventory,
  type ActiveOwnerResolution,
  type OwnershipConflict,
  type RegistryQuery,
  type RegistryRecord,
} from '../src/domain/registry/index.js'
import {
  CORE_KNOWN_SEAMS,
  ResolutionService,
  type RegistryReadModel,
} from '../src/domain/resolution/index.js'
import * as registryPlugin from '../src/plugins/registry-plugin.js'
import * as resolutionPlugin from '../src/plugins/resolution-plugin.js'

function seededResolver() {
  const registry = new RegistryService(new InMemoryRegistryPersistence())
  bootstrapCoreInventory((input) => registry.register(input))
  return { registry, resolver: new ResolutionService(registry) }
}

function rejected(review: { steps: readonly { option: string; verdict: string }[] }, option: string) {
  const step = review.steps.find((item) => item.option === option)
  assert.ok(step, option)
  assert.equal(step.verdict, 'rejected')
}

describe('capability resolution review', () => {
  it('A. reuses an active calendar.read owner', () => {
    const { resolver } = seededResolver()
    const review = resolver.review({
      capability: 'calendar.read',
      need: 'list upcoming calendar events',
    })
    assert.equal(review.kind, 'reuse')
    assert.equal(review.target?.owner, 'managed/integrations')
    assert.equal(review.target?.version, '0.1.0')
    assert.match(review.rationale, /already exposes/)
  })

  it('B. evolves the existing calendar owner instead of a new plugin', () => {
    const { resolver } = seededResolver()
    const review = resolver.review({
      capability: 'calendar.freebusy',
      need: 'richer attendee and free-busy filtering',
      behavior: 'attendee-freebusy',
    })
    assert.equal(review.kind, 'evolve-owner')
    assert.equal(review.target?.owner, 'managed/integrations')
    assert.equal(review.target?.version, '0.1.0')
    rejected(review, 'reuse')
    rejected(review, 'configure')
    assert.equal(review.steps.some((item) => item.option === 'new-plugin'), false)
  })

  it('C. recommends a known permission/config change', () => {
    const { resolver } = seededResolver()
    const review = resolver.review({
      capability: 'calendar.read',
      need: 'include free-busy when listing events',
      permissionOptions: [{
        owner: 'managed/integrations',
        permission: 'local.fake.calendar.freebusy',
        satisfiesNeed: true,
      }],
    })
    assert.equal(review.kind, 'configure')
    assert.equal(review.target?.owner, 'managed/integrations')
    assert.equal(review.target?.permission, 'local.fake.calendar.freebusy')
    rejected(review, 'reuse')
  })

  it('D. implements a Google provider on the existing calendar seam', () => {
    const { resolver } = seededResolver()
    const review = resolver.review({
      capability: 'calendar.read',
      need: 'replace fake calendar with Google while keeping the application seam',
      knownProviders: [{
        provider: 'google',
        seam: 'integrations.calendar',
        capabilities: ['calendar.read'],
        domains: ['calendar'],
      }],
    })
    assert.equal(review.kind, 'implement-provider')
    assert.equal(review.target?.seam, 'integrations.calendar')
    assert.equal(review.target?.provider, 'google')
    assert.equal(review.target?.owner, 'managed/integrations')
    rejected(review, 'reuse')
    rejected(review, 'evolve-owner')
  })

  it('E. recommends a new plugin only when a complete inventory proves novelty', () => {
    const { resolver } = seededResolver()
    const review = resolver.review({
      capability: 'matter.light.set',
      need: 'control Matter home devices',
      inventory: { complete: true, seams: CORE_KNOWN_SEAMS },
    })
    assert.equal(review.kind, 'new-plugin')
    for (const option of ['reuse', 'configure', 'evolve-owner', 'adopt-existing', 'implement-provider']) {
      rejected(review, option)
    }
    const created = review.steps.find((item) => item.option === 'new-plugin')
    assert.equal(created?.verdict, 'accepted')
    assert.match(review.rationale, /1–5|1-5/)
  })

  it('F. treats unknown without a complete inventory as insufficient-information', () => {
    const { resolver } = seededResolver()
    const review = resolver.review({
      capability: 'unknown.widget.sync',
      need: 'sync an unrecognized widget capability',
    })
    assert.equal(review.kind, 'insufficient-information')
    rejected(review, 'new-plugin')
    assert.match(review.rationale, /unknown is not absent/)
  })

  it('G. returns conflict and does not recommend a change', () => {
    const records = [
      {
        owner: 'managed/integrations',
        version: '0.1.0',
        capabilities: [{ id: 'calendar.read' }],
      },
      {
        owner: 'generated/calendar-helper',
        version: '0.2.0',
        capabilities: [{ id: 'calendar.read' }],
      },
    ] as unknown as RegistryRecord[]
    const registry: RegistryReadModel = {
      resolveActiveOwner(): ActiveOwnerResolution {
        return { kind: 'conflict', capability: 'calendar.read', records }
      },
      list(_query?: RegistryQuery) {
        return records
      },
      conflicts(): readonly OwnershipConflict[] {
        return [{ capability: 'calendar.read', records }]
      },
    }
    const review = new ResolutionService(registry).review({
      capability: 'calendar.read',
      need: 'list events',
    })
    assert.equal(review.kind, 'conflict')
    assert.equal(review.target, undefined)
    assert.match(review.recommendation, /conflict/)
    assert.equal(review.steps.length, 0)
  })

  it('adopts an inactive candidate instead of minting a duplicate', () => {
    const { registry, resolver } = seededResolver()
    registry.register({
      owner: 'generated/matter-home',
      version: '0.1.0',
      provenance: { kind: 'generated', origin: 'assistant' },
      evidence: 'Implemented',
      capabilities: [{ id: 'matter.light.set', permissions: [] }],
      runtimeSeams: ['integrations.home'],
    })
    const review = resolver.review({
      capability: 'matter.light.set',
      need: 'control Matter lights',
      inventory: { complete: true, seams: CORE_KNOWN_SEAMS },
    })
    assert.equal(review.kind, 'adopt-existing')
    assert.equal(review.target?.owner, 'generated/matter-home')
    rejected(review, 'reuse')
    rejected(review, 'evolve-owner')
  })

  it('does not treat an unrelated calendar provider as evidence for another domain', () => {
    const { resolver } = seededResolver()
    const review = resolver.review({
      capability: 'matter.light.set',
      need: 'control Matter home devices',
      knownProviders: [{
        provider: 'google',
        seam: 'integrations.calendar',
        capabilities: ['calendar.read'],
        domains: ['calendar'],
      }],
      inventory: { complete: true, seams: CORE_KNOWN_SEAMS },
    })
    assert.equal(review.kind, 'new-plugin')
    rejected(review, 'implement-provider')
  })

  it('ignores a provider option that does not bind a capability or domain', () => {
    const { resolver } = seededResolver()
    const review = resolver.review({
      capability: 'matter.light.set',
      need: 'control Matter home devices',
      knownProviders: [{ provider: 'google', seam: 'integrations.calendar' }],
      inventory: { complete: true, seams: CORE_KNOWN_SEAMS },
    })
    assert.equal(review.kind, 'new-plugin')
    rejected(review, 'implement-provider')
  })

  it('does not mutate registry state', () => {
    const { registry, resolver } = seededResolver()
    const before = registry.list().length
    resolver.review({
      capability: 'calendar.read',
      need: 'list events',
      permissionOptions: [{
        owner: 'managed/integrations',
        permission: 'local.fake.calendar.freebusy',
        satisfiesNeed: true,
      }],
    })
    assert.equal(registry.list().length, before)
    assert.equal(registry.get('managed/integrations', '0.1.0')?.approval, 'unreviewed')
    assert.equal(registry.get('managed/integrations', '0.1.0')?.status, 'active')
  })
})

describe('capability resolution plugin', () => {
  it('exposes an advisory public service and read-only review tool', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(registryPlugin)
    await ctx.plugin(resolutionPlugin)
    try {
      assert.ok(ctx.capabilityResolution)
      const reuse = ctx.capabilityResolution.review({
        capability: 'calendar.read',
        need: 'list events',
      })
      assert.equal(reuse.kind, 'reuse')
      assert.ok(ctx.tools.get('review_capability_resolution'))
      const result = await ctx.tools.execute({
        callId: CallId('test-review-resolution'),
        name: 'review_capability_resolution',
        arguments: {
          capability: 'unknown.widget.sync',
          need: 'sync widgets',
        },
        signal: AbortSignal.timeout(5000),
      })
      assert.equal(result.isError, false)
      assert.match(String(result.value), /"kind":"insufficient-information"/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('cannot promote an unknown capability to new-plugin via a model-declared completeness flag', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(registryPlugin)
    await ctx.plugin(resolutionPlugin)
    try {
      const tool = ctx.tools.get('review_capability_resolution')
      assert.ok(tool)
      assert.equal(JSON.stringify(tool).includes('inventoryComplete'), false)
      const result = await ctx.tools.execute({
        callId: CallId('test-review-cannot-self-assert-complete'),
        name: 'review_capability_resolution',
        arguments: {
          capability: 'unknown.widget.sync',
          need: 'sync widgets',
          inventoryComplete: true,
        },
        signal: AbortSignal.timeout(5000),
      })
      assert.equal(result.isError, false)
      const payload = JSON.parse(String(result.value)) as { kind: string }
      assert.equal(payload.kind, 'insufficient-information')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
