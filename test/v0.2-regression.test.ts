import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { CallId } from '@deepseek-ai/dsh-llm'
import { ActivationDeniedError, GovernanceAuthorityError, SimulatedCrashError, TrustedAuthorityCredential } from '../src/domain/governance/index.js'
import { CORE_KNOWN_SEAMS } from '../src/domain/resolution/index.js'
import { PersistenceIntegrityError, formatOperatorStatus, operatorStatus, parseCandidateIndexFile } from '../src/domain/self-extension/index.js'
import { bootAssistantControl, type AssistantControl } from '../src/runtime/boot.js'

const PLUGIN = `export const name = 'generated-v02-probe'
export const inject = ['tools']
export function apply(ctx) {
  const dispose = ctx.tools.register({
    name: 'v02_probe_ping',
    description: 'v0.2 regression probe',
    parameters: {},
    output: { schema: { type: 'string' }, render(_args, value) { return [{ type: 'text', text: String(value) }] } },
    async execute() { return 'pong' },
  })
  ctx.effect(() => dispose)
}
`

async function ping(ctx: AssistantControl['ctx']) {
  const result = await ctx.tools.execute({
    callId: CallId(`v02-${Math.random().toString(16).slice(2)}`),
    name: 'v02_probe_ping',
    arguments: {},
    signal: AbortSignal.timeout(5000),
  })
  assert.equal(result.isError, false, String(result.value))
  return String(result.value)
}

function surface(booted: AssistantControl) {
  const approvals = new Map(booted.ctx.candidateWorkspace.list().map((item) => [
    item.id,
    booted.ctx.extensionGovernance.inspectApproval(item.id)?.decision ?? 'unreviewed',
  ]))
  const fingerprints = new Map(booted.ctx.candidateWorkspace.list().flatMap((item) => {
    const fingerprint = booted.ctx.extensionGovernance.inspectApproval(item.id)?.fingerprint
    return fingerprint === undefined ? [] : [[item.id, fingerprint] as const]
  }))
  return operatorStatus({
    activation: booted.recoveryRoot.inspect(),
    registry: [...booted.ctx.capabilityRegistry.list()],
    candidates: [...booted.ctx.candidateWorkspace.list()],
    approvals,
    fingerprints,
    persistence: booted.diagnostics.persistence,
    reasons: booted.diagnostics.reasons,
  })
}

async function prepareCandidate(home: string, activate: boolean) {
  const first = await bootAssistantControl({ home })
  const review = first.ctx.capabilityResolution.review({
    capability: 'v02.probe.ping',
    need: 'v0.2.x release-confidence probe',
    inventory: { complete: true, seams: CORE_KNOWN_SEAMS },
  })
  assert.equal(review.kind, 'new-plugin')
  const created = first.ctx.candidateWorkspace.create({
    review,
    owner: 'generated/v02-probe',
    version: '0.1.0',
    manifest: { capabilities: ['v02.probe.ping'], tools: ['v02_probe_ping'], entryPoints: ['src/plugin.js'] },
  })
  first.ctx.candidateWorkspace.writeFile(created.id, 'package.json', `${JSON.stringify({ name: 'dsh-generated-v02-probe', type: 'module', main: 'src/plugin.js' }, null, 2)}\n`)
  first.ctx.candidateWorkspace.writeFile(created.id, 'src/plugin.js', PLUGIN)
  first.ctx.candidateValidation.validate(created.id)
  first.ctx.candidateWorkspace.seal(created.id)
  first.ctx.independentReview.reviewCandidate(created.id)
  const human = first.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
  const fingerprint = first.ctx.extensionGovernance.requestApproval(created.id).fingerprint
  first.recoveryRoot.recordApproval(human, { candidateId: created.id, fingerprint, decision: 'approved-for-exact-diff' })
  if (activate) await first.recoveryRoot.activate(created.id, human)
  return { first, created, human, fingerprint, review }
}

describe('v0.2.x release-confidence suite', () => {
  it('A. clean baseline boots trusted public seams', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-v02-a-'))
    const booted = await bootAssistantControl({ home })
    try {
      assert.ok(booted.ctx.tools.get('remember_memory'))
      assert.ok(booted.ctx.tools.get('retrieve_knowledge'))
      assert.ok(booted.ctx.tools.get('list_capabilities'))
      assert.ok(booted.ctx.tools.get('inspect_extension_governance'))
      assert.ok(booted.ctx.agents)
      assert.equal(booted.ctx.tools.get('v02_probe_ping'), undefined)
      const status = surface(booted)
      assert.equal(status.mode, 'normal')
      assert.equal(status.persistence, 'ok')
      assert.equal(status.activationState, 'idle')
      assert.match(formatOperatorStatus(status), /mode: normal/)
      assert.doesNotMatch(formatOperatorStatus(status), /secret|token|password/i)
    } finally {
      await booted.ctx.fiber.dispose()
    }
  })

  it('B. full governed lifecycle survives a fresh boot', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-v02-b-'))
    const { first, created, fingerprint } = await prepareCandidate(home, true)
    try {
      assert.equal(await ping(first.ctx), 'pong')
      const live = surface(first)
      assert.equal(live.currentDigest, first.ctx.candidateWorkspace.get(created.id).digest)
      assert.equal(live.currentFingerprint, fingerprint)
      assert.ok(live.active.some((item) => item === 'generated/v02-probe@0.1.0'))
    } finally {
      await first.ctx.fiber.dispose()
    }
    const second = await bootAssistantControl({ home })
    try {
      assert.equal(await ping(second.ctx), 'pong')
      assert.equal(second.ctx.capabilityRegistry.get('generated/v02-probe', '0.1.0')?.status, 'active')
      assert.equal(surface(second).currentDigest, second.ctx.candidateWorkspace.get(created.id).digest)
    } finally {
      await second.ctx.fiber.dispose()
    }
  })

  it('C. rollback stays inactive across restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-v02-c-'))
    const { first, human } = await prepareCandidate(home, true)
    try {
      await first.recoveryRoot.rollback(human)
    } finally {
      await first.ctx.fiber.dispose()
    }
    const second = await bootAssistantControl({ home })
    try {
      assert.equal(second.ctx.tools.get('v02_probe_ping'), undefined)
      assert.notEqual(second.ctx.capabilityRegistry.get('generated/v02-probe', '0.1.0')?.status, 'active')
      assert.ok(second.ctx.tools.get('remember_memory'))
    } finally {
      await second.ctx.fiber.dispose()
    }
  })

  it('D. missing artifact fails closed into Safe Mode', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-v02-d-'))
    const { first, created } = await prepareCandidate(home, true)
    await first.ctx.fiber.dispose()
    rmSync(join(home, 'self-extension', 'candidates', created.id), { recursive: true, force: true })
    const second = await bootAssistantControl({ home })
    try {
      const status = surface(second)
      assert.equal(second.diagnostics.safeMode, true)
      assert.equal(status.mode, 'safe-mode')
      assert.match(status.reasons.join('\n'), /missing-active-artifact/)
      assert.match(formatOperatorStatus(status), /missing-active-artifact/)
      assert.equal(second.ctx.tools.get('v02_probe_ping'), undefined)
      assert.ok(second.recoveryRoot.inspect())
      const human = second.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'operator-cli' })
      second.recoveryRoot.disable(human, 'generated/v02-probe', '0.1.0')
    } finally {
      await second.ctx.fiber.dispose()
    }
  })

  it('E. mutated artifact fails closed on digest mismatch', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-v02-e-'))
    const { first, created } = await prepareCandidate(home, true)
    await first.ctx.fiber.dispose()
    const plugin = join(home, 'self-extension', 'candidates', created.id, 'src', 'plugin.js')
    writeFileSync(plugin, `${readFileSync(plugin, 'utf8')}\nexport const mutated = true\n`)
    const second = await bootAssistantControl({ home })
    try {
      assert.equal(second.diagnostics.safeMode, true)
      assert.match(surface(second).reasons.join('\n'), /digest-mismatch/)
      assert.equal(second.ctx.tools.get('v02_probe_ping'), undefined)
    } finally {
      await second.ctx.fiber.dispose()
    }
  })

  it('F. interrupted pre-commit activation keeps prior LKG', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-v02-f-'))
    const { first, created, human } = await prepareCandidate(home, false)
    first.recoveryRoot.simulateInterrupt('registry-commit')
    await assert.rejects(() => first.recoveryRoot.activate(created.id, human), SimulatedCrashError)
    await first.ctx.fiber.dispose()
    const second = await bootAssistantControl({ home })
    try {
      assert.equal(second.ctx.tools.get('v02_probe_ping'), undefined)
      assert.notEqual(second.ctx.capabilityRegistry.get('generated/v02-probe', '0.1.0')?.status, 'active')
      assert.ok(second.ctx.tools.get('remember_memory'))
    } finally {
      await second.ctx.fiber.dispose()
    }
  })

  it('G. interrupted rollback completes on the next fresh boot', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-v02-g-'))
    const { first, created, human } = await prepareCandidate(home, true)
    try {
      assert.equal(await ping(first.ctx), 'pong')
      first.recoveryRoot.simulateInterrupt('rollback-pending')
      await assert.rejects(() => first.recoveryRoot.rollback(human), SimulatedCrashError)
    } finally {
      await first.ctx.fiber.dispose()
    }
    const second = await bootAssistantControl({ home })
    try {
      assert.equal(second.ctx.tools.get('v02_probe_ping'), undefined)
      assert.notEqual(second.ctx.capabilityRegistry.get('generated/v02-probe', '0.1.0')?.status, 'active')
      assert.equal(second.recoveryRoot.inspect().state, 'rolled-back')
    } finally {
      await second.ctx.fiber.dispose()
    }
    void created
  })

  it('H. persisted Safe Mode excludes generated extensions', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-v02-h-'))
    const { first, human } = await prepareCandidate(home, true)
    try {
      first.recoveryRoot.enterSafeMode(human)
    } finally {
      await first.ctx.fiber.dispose()
    }
    const second = await bootAssistantControl({ home })
    try {
      const status = surface(second)
      assert.equal(status.mode, 'safe-mode')
      assert.equal(second.ctx.tools.get('v02_probe_ping'), undefined)
      assert.ok(second.ctx.tools.get('inspect_extension_governance'))
      second.recoveryRoot.exitSafeMode(second.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'operator-cli' }))
      assert.equal(second.recoveryRoot.inspect().safeMode, false)
    } finally {
      await second.ctx.fiber.dispose()
    }
  })

  it('I. unknown or corrupt durable state does not auto-activate', async () => {
    const unknown = mkdtempSync(join(tmpdir(), 'dsh-v02-i-schema-'))
    mkdirSync(join(unknown, 'self-extension'), { recursive: true })
    writeFileSync(join(unknown, 'self-extension', 'authority.json'), '{"schemaVersion":99}\n')
    const schema = await bootAssistantControl({ home: unknown })
    try {
      assert.equal(schema.diagnostics.persistence, 'unknown-schema')
      assert.equal(schema.diagnostics.recoveryRequired, true)
      assert.ok(schema.recoveryRoot.inspect())
      assert.equal(schema.ctx.tools.get('v02_probe_ping'), undefined)
    } finally {
      await schema.ctx.fiber.dispose()
    }
    const corruptHome = mkdtempSync(join(tmpdir(), 'dsh-v02-i-corrupt-'))
    mkdirSync(join(corruptHome, 'self-extension'), { recursive: true })
    writeFileSync(join(corruptHome, 'self-extension', 'authority.json'), '{not-json')
    const corrupt = await bootAssistantControl({ home: corruptHome })
    try {
      assert.equal(corrupt.diagnostics.persistence, 'corrupt')
      assert.equal(corrupt.ctx.tools.get('v02_probe_ping'), undefined)
      assert.ok(corrupt.recoveryRoot.inspect())
    } finally {
      await corrupt.ctx.fiber.dispose()
    }
    const inconsistent = mkdtempSync(join(tmpdir(), 'dsh-v02-i-inconsistent-'))
    const { first } = await prepareCandidate(inconsistent, true)
    await first.ctx.fiber.dispose()
    const authorityPath = join(inconsistent, 'self-extension', 'authority.json')
    const authority = JSON.parse(readFileSync(authorityPath, 'utf8')) as {
      registry: { records: Record<string, unknown>[] }
    }
    authority.registry.records.push({
      owner: 'generated/ghost',
      version: '0.0.1',
      provenance: { kind: 'generated', origin: 'assistant' },
      status: 'active',
      evidence: 'Implemented',
      approval: 'unreviewed',
      capabilities: [{ id: 'ghost.x', permissions: [] }],
      permissions: [],
      runtimeSeams: [],
      tools: [],
      services: [],
      providers: [],
    })
    writeFileSync(authorityPath, `${JSON.stringify(authority, null, 2)}\n`)
    const drifted = await bootAssistantControl({ home: inconsistent })
    try {
      assert.equal(drifted.diagnostics.safeMode, true)
      assert.match(surface(drifted).reasons.join('\n'), /inconsistent-active-owner/)
      assert.equal(drifted.ctx.tools.get('v02_probe_ping'), undefined)
    } finally {
      await drifted.ctx.fiber.dispose()
    }
  })

  it('J. backup/restore reconstructs only the committed capability', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-v02-j-src-'))
    const backup = mkdtempSync(join(tmpdir(), 'dsh-v02-j-bak-'))
    const dest = mkdtempSync(join(tmpdir(), 'dsh-v02-j-dst-'))
    const { first, created, human } = await prepareCandidate(home, true)
    const digest = first.ctx.candidateWorkspace.get(created.id).digest
    try {
      const manifest = first.recoveryRoot.backup(human, backup)
      assert.equal(manifest.kind, 'self-extension-authority')
      assert.ok(manifest.excludes.includes('secrets'))
      assert.throws(
        () => first.recoveryRoot.backup(new TrustedAuthorityCredential(Symbol('forged'), { kind: 'human-control', source: 'operator-cli' }), `${backup}-forged`),
        GovernanceAuthorityError,
      )
    } finally {
      await first.ctx.fiber.dispose()
    }
    const empty = await bootAssistantControl({ home: dest })
    const destHuman = empty.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'operator-cli' })
    try {
      empty.recoveryRoot.restore(destHuman, backup)
    } finally {
      await empty.ctx.fiber.dispose()
    }
    const restored = await bootAssistantControl({ home: dest })
    try {
      assert.equal(await ping(restored.ctx), 'pong')
      assert.equal(restored.ctx.candidateWorkspace.get(created.id).digest, digest)
      assert.equal((restored.ctx.extensionRecovery as { backup?: unknown; restore?: unknown }).backup, undefined)
      assert.equal((restored.ctx.extensionRecovery as { backup?: unknown; restore?: unknown }).restore, undefined)
    } finally {
      await restored.ctx.fiber.dispose()
    }
  })

  it('K. restore cannot expand approved-but-inactive authority', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-v02-k-src-'))
    const backup = mkdtempSync(join(tmpdir(), 'dsh-v02-k-bak-'))
    const dest = mkdtempSync(join(tmpdir(), 'dsh-v02-k-dst-'))
    const { first, human } = await prepareCandidate(home, false)
    try {
      first.recoveryRoot.backup(human, backup)
    } finally {
      await first.ctx.fiber.dispose()
    }
    const empty = await bootAssistantControl({ home: dest })
    try {
      empty.recoveryRoot.restore(empty.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'operator-cli' }), backup)
    } finally {
      await empty.ctx.fiber.dispose()
    }
    const restored = await bootAssistantControl({ home: dest })
    try {
      assert.equal(restored.ctx.tools.get('v02_probe_ping'), undefined)
      assert.equal(restored.ctx.capabilityRegistry.get('generated/v02-probe', '0.1.0'), undefined)
      const [candidate] = restored.ctx.candidateWorkspace.list()
      assert.ok(candidate)
      assert.equal(restored.ctx.extensionGovernance.inspectApproval(candidate.id)?.decision, 'approved-for-exact-diff')
    } finally {
      await restored.ctx.fiber.dispose()
    }
  })

  it('restore fails closed when an approved-but-inactive artifact was tampered in the backup', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-v02-tamper-src-'))
    const backup = mkdtempSync(join(tmpdir(), 'dsh-v02-tamper-bak-'))
    const dest = mkdtempSync(join(tmpdir(), 'dsh-v02-tamper-dst-'))
    const { first, created, human, fingerprint } = await prepareCandidate(home, false)
    try {
      first.recoveryRoot.backup(human, backup)
    } finally {
      await first.ctx.fiber.dispose()
    }
    const plugin = join(backup, 'candidates', created.id, 'src', 'plugin.js')
    writeFileSync(plugin, `${readFileSync(plugin, 'utf8')}\nexport const tampered = true\n`)
    const empty = await bootAssistantControl({ home: dest })
    const destHuman = empty.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'operator-cli' })
    try {
      assert.throws(() => empty.recoveryRoot.restore(destHuman, backup), PersistenceIntegrityError)
    } finally {
      await empty.ctx.fiber.dispose()
    }
    const after = await bootAssistantControl({ home: dest })
    try {
      assert.equal(after.ctx.tools.get('v02_probe_ping'), undefined)
      assert.equal(after.ctx.capabilityRegistry.get('generated/v02-probe', '0.1.0'), undefined)
      assert.equal(after.ctx.candidateWorkspace.list().some((item) => item.id === created.id), false)
      await assert.rejects(
        () => after.recoveryRoot.activate(created.id, after.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'operator-cli' })),
        ActivationDeniedError,
      )
      void fingerprint
    } finally {
      await after.ctx.fiber.dispose()
    }
  })

  it('backup copies only required sealed artifacts and rejects overlapping paths', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-v02-bak-src-'))
    const backup = mkdtempSync(join(tmpdir(), 'dsh-v02-bak-out-'))
    const { first, created, human } = await prepareCandidate(home, true)
    const developing = first.ctx.candidateWorkspace.create({
      review: first.ctx.capabilityResolution.review({
        capability: 'v02.probe.draft',
        need: 'unsealed workspace must not enter recovery backup',
        inventory: { complete: true, seams: CORE_KNOWN_SEAMS },
      }),
      owner: 'generated/v02-draft',
      version: '0.1.0',
      manifest: { capabilities: ['v02.probe.draft'], tools: ['v02_probe_draft'], entryPoints: ['src/plugin.js'] },
    })
    first.ctx.candidateWorkspace.writeFile(developing.id, 'src/plugin.js', 'export const draft = true\n')
    const authorityBefore = readFileSync(join(home, 'self-extension', 'authority.json'), 'utf8')
    try {
      assert.throws(() => first.recoveryRoot.backup(human, home), PersistenceIntegrityError)
      assert.throws(() => first.recoveryRoot.backup(human, join(home, 'self-extension')), PersistenceIntegrityError)
      assert.throws(() => first.recoveryRoot.backup(human, join(home, 'self-extension', 'candidates')), PersistenceIntegrityError)
      assert.equal(readFileSync(join(home, 'self-extension', 'authority.json'), 'utf8'), authorityBefore)
      assert.ok(existsSync(join(home, 'self-extension', 'candidates', created.id)))
      assert.ok(existsSync(join(home, 'self-extension', 'candidates', developing.id)))
      const manifest = first.recoveryRoot.backup(human, backup)
      assert.ok(manifest.excludes.includes('unsealed-candidate-workspaces'))
      assert.ok(existsSync(join(backup, 'candidates', created.id, 'src', 'plugin.js')))
      assert.equal(existsSync(join(backup, 'candidates', developing.id)), false)
      const index = JSON.parse(readFileSync(join(backup, 'candidates', 'index.json'), 'utf8')) as {
        candidates: { record: { id: string } }[]
      }
      assert.deepEqual(index.candidates.map((row) => row.record.id), [created.id])
    } finally {
      await first.ctx.fiber.dispose()
    }
  })

  it('restore rejects a traversal candidate id before touching destination state', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-v02-trav-src-'))
    const backup = mkdtempSync(join(tmpdir(), 'dsh-v02-trav-bak-'))
    const dest = mkdtempSync(join(tmpdir(), 'dsh-v02-trav-dst-'))
    const { first, human } = await prepareCandidate(home, true)
    try {
      first.recoveryRoot.backup(human, backup)
    } finally {
      await first.ctx.fiber.dispose()
    }
    const indexPath = join(backup, 'candidates', 'index.json')
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { candidates: { record: { id: string } }[] }
    index.candidates[0]!.record.id = '../../outside-artifact'
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`)
    assert.throws(() => parseCandidateIndexFile(index), PersistenceIntegrityError)
    const seeded = await bootAssistantControl({ home: dest })
    await seeded.ctx.fiber.dispose()
    const authorityBefore = readFileSync(join(dest, 'self-extension', 'authority.json'), 'utf8')
    const sentinel = join(dest, 'outside-artifact')
    writeFileSync(sentinel, 'keep\n')
    const empty = await bootAssistantControl({ home: dest })
    try {
      assert.throws(
        () => empty.recoveryRoot.restore(empty.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'operator-cli' }), backup),
        PersistenceIntegrityError,
      )
      assert.equal(readFileSync(join(dest, 'self-extension', 'authority.json'), 'utf8'), authorityBefore)
      assert.equal(readFileSync(sentinel, 'utf8'), 'keep\n')
      assert.equal(existsSync(join(dest, 'self-extension', 'candidates', 'outside-artifact')), false)
    } finally {
      await empty.ctx.fiber.dispose()
    }
  })

  it('L. retired artifact remaining on disk never remounts', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-v02-l-'))
    const { first, created, human } = await prepareCandidate(home, true)
    try {
      first.recoveryRoot.disable(human, 'generated/v02-probe', '0.1.0')
    } finally {
      await first.ctx.fiber.dispose()
    }
    const second = await bootAssistantControl({ home })
    try {
      assert.ok(second.ctx.candidateWorkspace.get(created.id).sealed)
      assert.equal(second.ctx.tools.get('v02_probe_ping'), undefined)
      assert.notEqual(second.ctx.capabilityRegistry.get('generated/v02-probe', '0.1.0')?.status, 'active')
    } finally {
      await second.ctx.fiber.dispose()
    }
  })
})
