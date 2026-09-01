import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ActivationStatus } from '../src/domain/governance/types.js'
import type { ActivationCard, MissionControlView } from '../src/domain/workspace/types.js'
import {
  handleWebUiActivationRequest,
  type WebUiActivationContext,
} from '../src/product/web-ui-activations.js'
import { WebUiGovernanceMutations } from '../src/product/web-ui-governance-mutations.js'

const view = { identity: 'TARS-NG' } as MissionControlView

function activationCard(overrides: Partial<ActivationCard> = {}): ActivationCard {
  return {
    id: 'activation-1',
    kind: 'self-extension-activate',
    title: 'ACTIVATE',
    owner: 'generated/example',
    version: '0.1.0',
    candidateId: 'candidate-1',
    digest: 'digest-1',
    fingerprint: 'fingerprint-1',
    isolatedRuntime: true,
    capabilitiesAdded: [],
    capabilitiesRemoved: [],
    capabilitiesChanged: [],
    permissionsAdded: [],
    permissionsRemoved: [],
    permissionsChanged: [],
    toolsAdded: [],
    toolsRemoved: [],
    toolsChanged: [],
    effects: [],
    eligibilityOk: true,
    eligibilityDenials: [],
    status: 'APPROVED_NOT_ACTIVE',
    details: [],
    ...overrides,
  }
}

function status(overrides: Partial<ActivationStatus> = {}): ActivationStatus {
  return {
    state: 'active',
    safeMode: false,
    recoveryRequired: false,
    integrityVerified: true,
    ...overrides,
  }
}

function request(pathname: string, body: unknown) {
  return { method: 'POST', pathname, readJson: async () => body }
}

function context(overrides: Partial<WebUiActivationContext> = {}): WebUiActivationContext {
  return {
    authority: {
      activate: async () => status(),
      abandon: () => {},
    },
    mutations: new WebUiGovernanceMutations(() => ({ state: 'idle' })),
    activations: () => [activationCard()],
    project: () => ({ view, webUi: 'http://127.0.0.1:8787' }),
    ...overrides,
  }
}

function body(card = activationCard()) {
  return {
    id: card.id,
    candidateId: card.candidateId,
    digest: card.digest,
    fingerprint: card.fingerprint,
    confirm: true,
  }
}

describe('Web UI governance mutations', () => {
  it('projects local and governance busy states in priority order', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const mutations = new WebUiGovernanceMutations(() => ({ state: 'idle', lifecycleBusy: 'disable' }))
    assert.equal(mutations.inFlight(), 'disable')
    const running = mutations.run('activation', () => held)
    assert.equal(mutations.inFlight(), 'activation')
    const uninstall = mutations.run('uninstall', async () => {
      assert.equal(mutations.inFlight(), 'uninstall')
    })
    await uninstall
    assert.equal(mutations.inFlight(), 'activation')
    release()
    await running
    assert.equal(mutations.inFlight(), 'disable')
  })

  it('releases local state when a mutation fails', async () => {
    const mutations = new WebUiGovernanceMutations(() => ({ state: 'idle' }))
    await assert.rejects(mutations.run('recovery', async () => { throw new Error('failed') }))
    assert.equal(mutations.inFlight(), undefined)
  })
})

describe('Web UI activations', () => {
  it('activates only the exact confirmed card and broadcasts the result', async () => {
    const candidates: string[] = []
    const card = activationCard()
    const result = await handleWebUiActivationRequest(request('/api/activate', body(card)), context({
      activations: () => [card],
      authority: {
        activate: async (candidateId) => { candidates.push(candidateId); return status() },
        abandon: () => {},
      },
    }))
    assert.deepEqual(candidates, ['candidate-1'])
    assert.deepEqual(result, {
      status: 200,
      body: { view, webUi: 'http://127.0.0.1:8787' },
      broadcast: true,
    })
  })

  it('rejects missing confirmation, busy state, and stale evidence before activation', async () => {
    const noConfirm = await handleWebUiActivationRequest(request('/api/activate', {}), context())
    assert.deepEqual(noConfirm, { status: 409, body: { error: 'confirmation-required' } })

    const busy = await handleWebUiActivationRequest(request('/api/activate', body()), context({
      mutations: new WebUiGovernanceMutations(() => ({ state: 'activation-pending' })),
    }))
    assert.deepEqual(busy, {
      status: 409,
      body: { error: 'activation-in-flight', view, webUi: 'http://127.0.0.1:8787' },
    })

    const stale = await handleWebUiActivationRequest(request('/api/activate', {
      ...body(),
      digest: 'old',
    }), context())
    assert.deepEqual(stale, { status: 409, body: { error: 'stale-digest' } })
  })

  it('does not let a Skill activation card cross the extension activation authority', async () => {
    const skill = activationCard({
      kind: 'skill-activate',
      isolatedRuntime: false,
      skill: { id: 'skill-1', name: 'review', version: '1.0.0', digest: 'digest-1', generation: 2 },
    })
    const result = await handleWebUiActivationRequest(request('/api/activate', body(skill)), context({ activations: () => [skill] }))
    assert.deepEqual(result, { status: 409, body: { error: 'unknown-activation' } })
  })

  it('returns bounded diagnostics for a failed activation', async () => {
    const result = await handleWebUiActivationRequest(request('/api/activate', body()), context({
      authority: {
        activate: async () => status({
          state: 'activation-failed',
          recoveryRequired: true,
          lastFailure: {
            candidateId: 'candidate-1',
            phase: 'health',
            diagnostics: 'health check failed',
            rollbackAttempted: true,
            rollbackSucceeded: true,
            safeModeRequired: false,
          },
        }),
        abandon: () => {},
      },
    }))
    assert.equal(result?.status, 409)
    const response = result?.body as { error?: string; phase?: string; diagnostics?: string; rollbackSucceeded?: boolean }
    assert.equal(response.error, 'activation-failed')
    assert.equal(response.phase, 'health')
    assert.match(response.diagnostics ?? '', /health check failed/)
    assert.equal(response.rollbackSucceeded, true)
  })

  it('abandons only an eligible failed activation card', async () => {
    const abandoned: unknown[][] = []
    const failed = activationCard({ status: 'ACTIVATION_FAILED' })
    const result = await handleWebUiActivationRequest(request('/api/activation/abandon', body(failed)), context({
      activations: () => [failed],
      authority: {
        activate: async () => status(),
        abandon: (...args) => { abandoned.push(args) },
      },
    }))
    assert.equal(result?.status, 200)
    assert.deepEqual(abandoned, [['candidate-1', 'fingerprint-1']])

    const stale = await handleWebUiActivationRequest(request('/api/activation/abandon', body()), context())
    assert.deepEqual(stale, { status: 409, body: { error: 'stale-activation' } })
  })
})
