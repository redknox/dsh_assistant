import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RollbackDeniedError, UninstallDeniedError } from '../src/domain/governance/errors.js'
import type { ActivationStatus } from '../src/domain/governance/types.js'
import type { MissionControlView, RollbackCard, UserPluginView } from '../src/domain/workspace/types.js'
import {
  handleWebUiGovernanceLifecycleRequest,
  type WebUiGovernanceLifecycleContext,
} from '../src/product/web-ui-governance-lifecycle.js'
import { WebUiGovernanceMutations } from '../src/product/web-ui-governance-mutations.js'

const webUi = 'http://127.0.0.1:8787'

function status(overrides: Partial<ActivationStatus> = {}): ActivationStatus {
  return {
    state: 'active',
    safeMode: false,
    recoveryRequired: false,
    integrityVerified: true,
    ...overrides,
  }
}

function plugin(overrides: Partial<UserPluginView> = {}): UserPluginView {
  return {
    id: 'plugin-1',
    owner: 'generated/example',
    version: '0.1.0',
    provenance: 'candidate',
    candidateId: 'candidate-1',
    digest: 'digest-1',
    capabilities: ['text.example'],
    tools: ['text_example'],
    mounted: true,
    registryGeneration: 3,
    dependency: { severity: 'none', dependents: [] },
    uninstallable: true,
    ...overrides,
  }
}

function rollbackCard(overrides: Partial<RollbackCard> = {}): RollbackCard {
  return {
    id: 'rollback-3-2',
    kind: 'system-state-rollback',
    title: 'Rollback system state',
    currentGeneration: 3,
    targetGeneration: 2,
    fingerprint: 'rollback-fingerprint',
    reason: 'restore LKG',
    ownerChanges: [],
    capabilitiesAdded: [],
    capabilitiesRemoved: [],
    toolsAdded: [],
    toolsRemoved: [],
    mountsAdded: [],
    mountsRemoved: [],
    recoveryRequired: false,
    actionable: true,
    ...overrides,
  }
}

function view(overrides: Partial<MissionControlView> = {}): MissionControlView {
  return {
    identity: 'TARS-NG',
    plugins: [plugin()],
    rollback: rollbackCard(),
    ...overrides,
  } as MissionControlView
}

function context(overrides: Partial<WebUiGovernanceLifecycleContext> = {}): WebUiGovernanceLifecycleContext {
  let current = status()
  return {
    authority: {
      inspect: () => current,
      uninstall: async () => current,
      rollback: async () => current,
      exitSafeMode: () => current,
    },
    mutations: new WebUiGovernanceMutations(() => current),
    project: () => ({ view: view(), webUi }),
    ...overrides,
  }
}

function request(pathname: string, body: unknown) {
  return { method: 'POST', pathname, readJson: async () => body }
}

function uninstallBody(card = plugin()) {
  return {
    id: card.id,
    owner: card.owner,
    version: card.version,
    candidateId: card.candidateId,
    digest: card.digest,
    registryGeneration: card.registryGeneration,
    confirm: true,
  }
}

function rollbackBody(card = rollbackCard()) {
  return {
    id: card.id,
    fingerprint: card.fingerprint,
    currentGeneration: card.currentGeneration,
    targetGeneration: card.targetGeneration,
    confirm: true,
  }
}

describe('Web UI governance lifecycle', () => {
  it('ignores unrelated routes and rejects malformed or unconfirmed mutations', async () => {
    assert.equal(await handleWebUiGovernanceLifecycleRequest(request('/api/skill', {}), context()), undefined)
    assert.deepEqual(
      await handleWebUiGovernanceLifecycleRequest(request('/api/uninstall', null), context()),
      { status: 400, body: { error: 'malformed' } },
    )
    assert.deepEqual(
      await handleWebUiGovernanceLifecycleRequest(request('/api/rollback', {}), context()),
      { status: 409, body: { error: 'confirmation-required' } },
    )
  })

  it('uninstalls only the exact projected plugin and forwards dependent acknowledgement', async () => {
    const calls: unknown[][] = []
    const result = await handleWebUiGovernanceLifecycleRequest(request('/api/uninstall', {
      ...uninstallBody(),
      acknowledgeDependents: true,
    }), context({
      authority: {
        inspect: () => status(),
        uninstall: async (...args) => { calls.push(args); return status() },
        rollback: async () => status(),
        exitSafeMode: () => status(),
      },
    }))
    assert.deepEqual(calls, [['generated/example', '0.1.0', true]])
    assert.deepEqual(result, { status: 200, body: { view: view(), webUi }, broadcast: true })

    const stale = await handleWebUiGovernanceLifecycleRequest(request('/api/uninstall', {
      ...uninstallBody(),
      registryGeneration: 2,
    }), context())
    assert.deepEqual(stale, { status: 409, body: { error: 'stale-registry' } })
  })

  it('preserves uninstall denials and bounds unexpected diagnostics', async () => {
    const denial = await handleWebUiGovernanceLifecycleRequest(request('/api/uninstall', uninstallBody()), context({
      authority: {
        inspect: () => status(),
        uninstall: async () => { throw new UninstallDeniedError([{ reason: 'dependency-blocked', detail: 'dependent' }]) },
        rollback: async () => status(),
        exitSafeMode: () => status(),
      },
    }))
    assert.equal((denial?.body as { error?: string }).error, 'uninstall-denied')
    assert.equal(denial?.broadcast, true)

    const failed = await handleWebUiGovernanceLifecycleRequest(request('/api/uninstall', uninstallBody()), context({
      authority: {
        inspect: () => status(),
        uninstall: async () => { throw new Error('secret /Users/private/.tars-ng Bearer sk-example-secret') },
        rollback: async () => status(),
        exitSafeMode: () => status(),
      },
    }))
    assert.equal((failed?.body as { error?: string }).error, 'uninstall-failed')
    assert.doesNotMatch(JSON.stringify(failed?.body), /Users\/private|sk-example-secret/)
  })

  it('binds rollback to the exact card and reports governance denials', async () => {
    let rolledBack = 0
    const exact = await handleWebUiGovernanceLifecycleRequest(request('/api/rollback', rollbackBody()), context({
      authority: {
        inspect: () => status(),
        uninstall: async () => status(),
        rollback: async () => { rolledBack += 1; return status() },
        exitSafeMode: () => status(),
      },
    }))
    assert.equal(exact?.status, 200)
    assert.equal(exact?.broadcast, true)
    assert.equal(rolledBack, 1)

    const denied = await handleWebUiGovernanceLifecycleRequest(request('/api/rollback', rollbackBody()), context({
      authority: {
        inspect: () => status(),
        uninstall: async () => status(),
        rollback: async () => { throw new RollbackDeniedError([{ reason: 'lkg-invalid', detail: 'invalid' }]) },
        exitSafeMode: () => status(),
      },
    }))
    assert.equal((denied?.body as { error?: string }).error, 'rollback-denied')
  })

  it('blocks lifecycle routes while another governance mutation is in flight', async () => {
    const busy = context({
      mutations: new WebUiGovernanceMutations(() => status({ lifecycleBusy: 'activation' })),
    })
    const result = await handleWebUiGovernanceLifecycleRequest(request('/api/uninstall', uninstallBody()), busy)
    assert.deepEqual(result, {
      status: 409,
      body: { error: 'activation-in-flight', view: view(), webUi },
    })
  })

  it('keeps recovery policy, diagnostics, and Safe Mode exit behind the same interface', async () => {
    const readyRollback = await handleWebUiGovernanceLifecycleRequest(request('/api/recovery', {
      action: 'rollback',
      confirm: true,
    }), context())
    assert.equal((readyRollback?.body as { error?: string }).error, 'ready-state-rollback')

    const diagnostics = await handleWebUiGovernanceLifecycleRequest(request('/api/recovery', {
      action: 'diagnostics',
    }), context({ diagnostics: { persistence: 'durable', reasons: ['healthy'] } }))
    assert.equal(diagnostics?.status, 200)
    assert.match((diagnostics?.body as { acknowledgement?: { text: string } }).acknowledgement?.text ?? '', /durable.*healthy.*safe-mode false/)

    const profileRecovery = await handleWebUiGovernanceLifecycleRequest(request('/api/recovery', {
      action: 'exit-safe-mode',
      confirm: true,
    }), context({
      project: () => ({
        view: view({ runtimeContext: { safeMode: true, profileCompositionError: 'broken profile' } } as Partial<MissionControlView>),
        webUi,
      }),
    }))
    assert.equal((profileRecovery?.body as { error?: string }).error, 'profile-composition-recovery')
  })
})
