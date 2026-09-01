import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SkillContractError } from '../src/domain/skill/errors.js'
import type { MissionControlView, SkillProjection } from '../src/domain/workspace/types.js'
import {
  handleWebUiSkillRequest,
  type WebUiSkillCommand,
  type WebUiSkillContext,
} from '../src/product/web-ui-skills.js'

const webUi = 'http://127.0.0.1:8787'

function skill(overrides: Partial<SkillProjection> = {}): SkillProjection {
  return {
    id: 'skill-1',
    name: 'weekly-review',
    version: '1.0.0',
    profile: 'assistant',
    provenance: 'third-party',
    origin: 'import',
    lifecycle: 'approval-requested',
    sealed: true,
    modelInvocable: true,
    userInvocable: true,
    description: 'Review the week.',
    resources: [],
    validationPassed: true,
    reviewComplete: true,
    approvalFingerprint: 'fingerprint-1',
    digest: 'digest-1',
    dependsOn: [],
    dependents: [],
    system: false,
    generation: 4,
    ...overrides,
  }
}

function view(overrides: Partial<MissionControlView> = {}): MissionControlView {
  return {
    identity: 'TARS-NG',
    systemState: 'READY',
    skills: [skill()],
    ...overrides,
  } as MissionControlView
}

function context(
  commands: WebUiSkillCommand[] = [],
  projected = view(),
  execute?: (command: WebUiSkillCommand) => void,
): WebUiSkillContext {
  return {
    authority: {
      execute: execute ?? ((command) => { commands.push(command) }),
    },
    project: (acknowledgement) => ({
      view: projected,
      webUi,
      ...(acknowledgement ? { acknowledgement } : {}),
    }),
  }
}

function request(body: unknown, pathname = '/api/skill') {
  return { method: 'POST', pathname, readJson: async () => body }
}

function body(action: string, projected = skill()) {
  return {
    action,
    id: projected.id,
    name: projected.name,
    version: projected.version,
    digest: projected.digest,
    fingerprint: projected.approvalFingerprint,
    generation: projected.generation,
    confirm: true,
  }
}

describe('Web UI Skills', () => {
  it('declines unrelated routes and rejects malformed or unconfirmed requests', async () => {
    assert.equal(await handleWebUiSkillRequest(request({}, '/api/view'), context()), undefined)
    assert.deepEqual(
      await handleWebUiSkillRequest(request(null), context()),
      { status: 400, body: { error: 'malformed' } },
    )
    assert.deepEqual(
      await handleWebUiSkillRequest(request({ action: 'approve' }), context()),
      { status: 409, body: { error: 'confirmation-required' } },
    )
  })

  it('turns an exact approval card into a bounded command and acknowledgement', async () => {
    const commands: WebUiSkillCommand[] = []
    const result = await handleWebUiSkillRequest(request(body('approve')), context(commands))
    assert.deepEqual(commands, [{ action: 'approve', id: 'skill-1', fingerprint: 'fingerprint-1' }])
    assert.deepEqual(result, {
      status: 200,
      body: {
        view: view(),
        webUi,
        acknowledgement: { text: 'Skill approve recorded.' },
      },
      broadcast: true,
    })
  })

  it('returns an actionable user-facing receipt after Skill activation', async () => {
    const approved = skill({ lifecycle: 'approved' })
    const commands: WebUiSkillCommand[] = []
    const result = await handleWebUiSkillRequest(
      request(body('activate', approved)),
      context(commands, view({ skills: [approved] })),
    )
    assert.deepEqual(commands, [{ action: 'activate', id: 'skill-1' }])
    assert.deepEqual((result?.body as { acknowledgement?: unknown }).acknowledgement, {
      text: 'weekly-review@1.0.0 is live and ready to use.',
      action: {
        kind: 'open-capability',
        label: 'VIEW CAPABILITY',
        capabilityId: 'skill:skill-1',
      },
    })
  })

  it('rejects stale evidence and lifecycle before executing authority', async () => {
    const commands: WebUiSkillCommand[] = []
    const staleDigest = await handleWebUiSkillRequest(request({ ...body('approve'), digest: 'old' }), context(commands))
    assert.deepEqual(staleDigest, { status: 409, body: { error: 'stale-digest' } })

    const approved = skill({ lifecycle: 'approved' })
    const staleLifecycle = await handleWebUiSkillRequest(
      request(body('approve', approved)),
      context(commands, view({ skills: [approved] })),
    )
    assert.deepEqual(staleLifecycle, { status: 409, body: { error: 'stale-lifecycle' } })
    assert.deepEqual(commands, [])
  })

  it('requires the exact hard-dependent acknowledgement for disable and uninstall', async () => {
    const active = skill({ lifecycle: 'active', dependents: ['dependent-1', 'dependent-2'] })
    const projected = view({ skills: [active] })
    const commands: WebUiSkillCommand[] = []
    const missing = await handleWebUiSkillRequest(request(body('uninstall', active)), context(commands, projected))
    assert.deepEqual(missing, {
      status: 409,
      body: {
        error: 'dependents-required',
        dependents: ['dependent-1', 'dependent-2'],
        detail: 'hard dependents must be acknowledged: dependent-1, dependent-2',
        view: projected,
        webUi,
      },
    })

    const stale = await handleWebUiSkillRequest(request({
      ...body('disable', active),
      acknowledgeDependents: true,
      dependents: ['dependent-1'],
    }), context(commands, projected))
    assert.equal((stale?.body as { error?: string }).error, 'stale-dependents')

    const accepted = await handleWebUiSkillRequest(request({
      ...body('uninstall', active),
      acknowledgeDependents: true,
      dependents: ['dependent-2', 'dependent-1'],
    }), context(commands, projected))
    assert.equal(accepted?.status, 200)
    assert.deepEqual(commands, [{ action: 'uninstall', id: 'skill-1', dependents: ['dependent-2', 'dependent-1'] }])
  })

  it('withholds activation and reactivation when the live catalog is unsafe', async () => {
    const approved = skill({ lifecycle: 'approved' })
    const withheld = view({
      skills: [approved],
      skillCatalog: { state: 'withheld', failed: ['skill-1'], recoveryRequired: true },
    })
    const result = await handleWebUiSkillRequest(request(body('activate', approved)), context([], withheld))
    assert.deepEqual(result, {
      status: 409,
      body: { error: 'catalog-withheld', view: withheld, webUi },
    })
  })

  it('binds rollback to the projected target rather than caller-selected metadata', async () => {
    const target = skill({ lifecycle: 'disabled' })
    const projected = view({
      skills: [target],
      skillRollback: {
        name: target.name,
        version: target.version,
        digest: target.digest,
        generation: target.generation,
      },
    })
    const commands: WebUiSkillCommand[] = []
    const result = await handleWebUiSkillRequest(request(body('rollback', target)), context(commands, projected))
    assert.equal(result?.status, 200)
    assert.deepEqual(commands, [{ action: 'rollback' }])
  })

  it('preserves catalog error codes and redacts unexpected authority failures', async () => {
    const catalog = await handleWebUiSkillRequest(request(body('approve')), context([], view(), () => {
      throw new SkillContractError('catalog-sync-failed', 'catalog could not sync')
    }))
    assert.equal((catalog?.body as { error?: string }).error, 'catalog-sync-failed')

    const failed = await handleWebUiSkillRequest(request(body('approve')), context([], view(), () => {
      throw new Error('secret /Users/private/.tars-ng Bearer sk-skill-secret')
    }))
    assert.equal((failed?.body as { error?: string }).error, 'skill-action-denied')
    assert.doesNotMatch(JSON.stringify(failed?.body), /sk-skill-secret/)
    assert.equal(failed?.broadcast, undefined)
  })
})
