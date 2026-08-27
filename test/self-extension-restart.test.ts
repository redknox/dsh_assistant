import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SimulatedCrashError } from '../src/domain/governance/index.js'
import { PersistenceSchemaError, formatOperatorStatus, operatorStatus } from '../src/domain/self-extension/index.js'
import { digestFiles } from '../src/domain/candidate/digest.js'
import { listSourceFiles } from '../src/domain/candidate/files.js'
import { selfExtensionPaths } from '../src/domain/self-extension/home.js'
import { GENERATED_EXTENSION_API_V1 } from '../src/domain/workbench/index.js'
import { bootAssistantControl } from '../src/runtime/boot.js'
import type { ResolutionReview } from '../src/domain/resolution/index.js'

const PLUGIN = `export const name = 'generated-restart-probe'
export const inject = ['tools']
export function apply(ctx) {
  const dispose = ctx.tools.register({
    name: 'restart_probe_ping',
    description: 'Restart durability probe',
    parameters: {},
    output: { schema: { type: 'string' }, render(_args, value) { return [{ type: 'text', text: String(value) }] } },
    async execute() { return 'pong' },
  })
  ctx.effect(() => dispose)
}
`

const PLUGIN_B = `export const name = 'generated-restart-probe-b'
export const inject = ['tools']
export function apply(ctx) {
  const dispose = ctx.tools.register({
    name: 'restart_probe_alt',
    description: 'Second restart durability probe',
    parameters: {},
    output: { schema: { type: 'string' }, render(_args, value) { return [{ type: 'text', text: String(value) }] } },
    async execute() { return 'alt' },
  })
  ctx.effect(() => dispose)
}
`

function review(): ResolutionReview {
  return {
    kind: 'new-plugin',
    capability: 'restart.probe.ping',
    need: 'prove restart reconstruction',
    recommendation: 'new plugin',
    rationale: 'no owner',
    implications: [],
    assumptions: [],
    unresolved: [],
    steps: [],
    registryFacts: { exact: { kind: 'unknown', capability: 'restart.probe.ping' }, domainOwners: [], conflicts: [] },
  }
}

async function ping(ctx: { tools: { get(name: string): unknown; execute(input: unknown): Promise<{ isError: boolean; value?: unknown }> } }) {
  const result = await ctx.tools.execute({
    callId: CallId(`ping-${Math.random().toString(16).slice(2)}`),
    name: 'restart_probe_ping',
    arguments: {},
    signal: AbortSignal.timeout(5000),
  })
  assert.equal(result.isError, false, String(result.value))
  return String(result.value)
}

async function prepareCandidate(home: string) {
  const first = await bootAssistantControl({ home })
  const created = first.ctx.candidateWorkspace.create({
    review: review(),
    owner: 'generated/restart-probe',
    version: '0.1.0',
    manifest: { capabilities: ['restart.probe.ping'], tools: ['restart_probe_ping'], entryPoints: ['src/plugin.js'] },
  })
  first.ctx.candidateWorkspace.writeFile(created.id, 'package.json', `${JSON.stringify({ name: 'dsh-generated-restart-probe', type: 'module', main: 'src/plugin.js' }, null, 2)}\n`)
  first.ctx.candidateWorkspace.writeFile(created.id, 'src/plugin.js', PLUGIN)
  first.ctx.candidateValidation.validate(created.id)
  first.ctx.candidateWorkspace.seal(created.id)
  first.ctx.independentReview.reviewCandidate(created.id)
  const human = first.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
  const fingerprint = first.ctx.extensionGovernance.requestApproval(created.id).fingerprint
  first.recoveryRoot.recordApproval(human, { candidateId: created.id, fingerprint, decision: 'approved-for-exact-diff' })
  return { first, created, human, fingerprint }
}

function reviewB(): ResolutionReview {
  return {
    kind: 'new-plugin',
    capability: 'restart.probe.alt',
    need: 'prove multi-extension remount preflight',
    recommendation: 'new plugin',
    rationale: 'no owner',
    implications: [],
    assumptions: [],
    unresolved: [],
    steps: [],
    registryFacts: { exact: { kind: 'unknown', capability: 'restart.probe.alt' }, domainOwners: [], conflicts: [] },
  }
}

async function prepareSecondCandidate(booted: Awaited<ReturnType<typeof bootAssistantControl>>) {
  const created = booted.ctx.candidateWorkspace.create({
    review: reviewB(),
    owner: 'generated/restart-probe-b',
    version: '0.1.0',
    manifest: { capabilities: ['restart.probe.alt'], tools: ['restart_probe_alt'], entryPoints: ['src/plugin.js'] },
  })
  booted.ctx.candidateWorkspace.writeFile(created.id, 'package.json', `${JSON.stringify({ name: 'dsh-generated-restart-probe-b', type: 'module', main: 'src/plugin.js' }, null, 2)}\n`)
  booted.ctx.candidateWorkspace.writeFile(created.id, 'src/plugin.js', PLUGIN_B)
  booted.ctx.candidateValidation.validate(created.id)
  booted.ctx.candidateWorkspace.seal(created.id)
  booted.ctx.independentReview.reviewCandidate(created.id)
  const human = booted.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
  const fingerprint = booted.ctx.extensionGovernance.requestApproval(created.id).fingerprint
  booted.recoveryRoot.recordApproval(human, { candidateId: created.id, fingerprint, decision: 'approved-for-exact-diff' })
  return { created, human }
}

describe('Self-Extension durable restart', () => {
  it('A. committed active extension survives a fresh boot', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-se-a-'))
    const { first, created, human } = await prepareCandidate(home)
    try {
      const activated = await first.recoveryRoot.activate(created.id, human)
      assert.equal(activated.state, 'active')
      assert.equal(await ping(first.ctx), 'pong')
    } finally {
      await first.ctx.fiber.dispose()
    }
    const second = await bootAssistantControl({ home })
    try {
      assert.equal(second.ctx.capabilityRegistry.get('generated/restart-probe', '0.1.0')?.status, 'active')
      assert.equal(await ping(second.ctx), 'pong')
      assert.equal(second.recoveryRoot.inspect().lastKnownGood?.generation, first.recoveryRoot.inspect().lastKnownGood?.generation)
    } finally {
      await second.ctx.fiber.dispose()
    }
  })

  it('B. rollback survives a fresh boot', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-se-b-'))
    const { first, created, human } = await prepareCandidate(home)
    try {
      await first.recoveryRoot.activate(created.id, human)
      await first.recoveryRoot.rollback(human)
    } finally {
      await first.ctx.fiber.dispose()
    }
    const second = await bootAssistantControl({ home })
    try {
      assert.equal(second.ctx.tools.get('restart_probe_ping'), undefined)
      assert.notEqual(second.ctx.capabilityRegistry.get('generated/restart-probe', '0.1.0')?.status, 'active')
      assert.ok(second.ctx.tools.get('remember_memory'))
    } finally {
      await second.ctx.fiber.dispose()
    }
  })

  it('C/J. disk presence and approval do not activate across restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-se-c-'))
    const { first, created } = await prepareCandidate(home)
    const id = created.id
    await first.ctx.fiber.dispose()
    const second = await bootAssistantControl({ home })
    try {
      assert.equal(second.ctx.candidateWorkspace.get(id).sealed, true)
      assert.equal(second.ctx.extensionGovernance.inspectApproval(id)?.decision, 'approved-for-exact-diff')
      assert.equal(second.ctx.tools.get('restart_probe_ping'), undefined)
      assert.equal(second.ctx.capabilityRegistry.get('generated/restart-probe', '0.1.0'), undefined)
    } finally {
      await second.ctx.fiber.dispose()
    }
  })

  it('D. mutated artifact does not remount', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-se-d-'))
    const { first, created, human } = await prepareCandidate(home)
    try {
      await first.recoveryRoot.activate(created.id, human)
    } finally {
      await first.ctx.fiber.dispose()
    }
    const plugin = join(home, 'self-extension', 'candidates', created.id, 'src', 'plugin.js')
    writeFileSync(plugin, `${readFileSync(plugin, 'utf8')}\nexport const mutated = true\n`)
    const second = await bootAssistantControl({ home })
    try {
      assert.equal(second.diagnostics.safeMode, true)
      assert.match(second.diagnostics.reasons.join('\n'), /digest-mismatch/)
      assert.equal(second.ctx.tools.get('restart_probe_ping'), undefined)
    } finally {
      await second.ctx.fiber.dispose()
    }
  })

  it('E. interrupted activation before commit keeps prior LKG', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-se-e-'))
    const { first, created, human } = await prepareCandidate(home)
    first.recoveryRoot.simulateInterrupt('prepare')
    await assert.rejects(() => first.recoveryRoot.activate(created.id, human), SimulatedCrashError)
    await first.ctx.fiber.dispose()
    const second = await bootAssistantControl({ home })
    try {
      assert.equal(second.ctx.tools.get('restart_probe_ping'), undefined)
      assert.notEqual(second.ctx.capabilityRegistry.get('generated/restart-probe', '0.1.0')?.status, 'active')
    } finally {
      await second.ctx.fiber.dispose()
    }
  })

  it('F. interrupted activation after durable commit remounts the new version', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-se-f-'))
    const { first, created, human } = await prepareCandidate(home)
    first.recoveryRoot.simulateInterrupt('commit')
    await assert.rejects(() => first.recoveryRoot.activate(created.id, human), SimulatedCrashError)
    await first.ctx.fiber.dispose()
    const second = await bootAssistantControl({ home })
    try {
      assert.equal(second.ctx.capabilityRegistry.get('generated/restart-probe', '0.1.0')?.status, 'active')
      assert.equal(await ping(second.ctx), 'pong')
    } finally {
      await second.ctx.fiber.dispose()
    }
  })

  it('crash between tentative Registry update and authority commit keeps prior LKG', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-se-reg-'))
    const { first, created, human } = await prepareCandidate(home)
    first.recoveryRoot.simulateInterrupt('registry-commit')
    await assert.rejects(() => first.recoveryRoot.activate(created.id, human), SimulatedCrashError)
    const authority = JSON.parse(readFileSync(join(home, 'self-extension', 'authority.json'), 'utf8')) as {
      registry: { records: { owner: string; status: string }[] }
      activation: { state: string }
      recovery: { lastKnownGood?: { owners: { owner: string; status: string }[] } }
    }
    assert.equal(authority.registry.records.some((row) => row.owner === 'generated/restart-probe' && row.status === 'active'), false)
    assert.notEqual(authority.activation.state, 'active')
    await first.ctx.fiber.dispose()
    const second = await bootAssistantControl({ home })
    try {
      assert.equal(second.ctx.tools.get('restart_probe_ping'), undefined)
      assert.notEqual(second.ctx.capabilityRegistry.get('generated/restart-probe', '0.1.0')?.status, 'active')
      assert.equal(second.recoveryRoot.inspect().lastKnownGood?.owners.some((row) => row.owner === 'generated/restart-probe' && row.status === 'active'), false)
      assert.ok(second.ctx.tools.get('remember_memory'))
    } finally {
      await second.ctx.fiber.dispose()
    }
  })

  it('one missing generated artifact fails closed with zero generated mounts', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-se-multi-'))
    const { first, created, human } = await prepareCandidate(home)
    const secondCandidate = await prepareSecondCandidate(first)
    try {
      await first.recoveryRoot.activate(created.id, human)
      await first.recoveryRoot.activate(secondCandidate.created.id, secondCandidate.human)
      assert.equal(await ping(first.ctx), 'pong')
      assert.ok(first.ctx.tools.get('restart_probe_alt'))
    } finally {
      await first.ctx.fiber.dispose()
    }
    rmSync(join(home, 'self-extension', 'candidates', secondCandidate.created.id), { recursive: true, force: true })
    const second = await bootAssistantControl({ home })
    try {
      assert.equal(second.diagnostics.safeMode, true)
      assert.match(second.diagnostics.reasons.join('\n'), /missing-active-artifact/)
      assert.equal(second.ctx.tools.get('restart_probe_ping'), undefined)
      assert.equal(second.ctx.tools.get('restart_probe_alt'), undefined)
      assert.ok(second.recoveryRoot.inspect())
      assert.ok(second.ctx.tools.get('remember_memory'))
    } finally {
      await second.ctx.fiber.dispose()
    }
  })

  it('completes an interrupted rollback on the next boot', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-se-rb-'))
    const { first, created, human } = await prepareCandidate(home)
    try {
      await first.recoveryRoot.activate(created.id, human)
      first.recoveryRoot.simulateInterrupt('rollback-pending')
      await assert.rejects(() => first.recoveryRoot.rollback(human), SimulatedCrashError)
    } finally {
      await first.ctx.fiber.dispose()
    }
    const second = await bootAssistantControl({ home })
    try {
      assert.equal(second.ctx.tools.get('restart_probe_ping'), undefined)
      assert.notEqual(second.ctx.capabilityRegistry.get('generated/restart-probe', '0.1.0')?.status, 'active')
    } finally {
      await second.ctx.fiber.dispose()
    }
  })

  it('G. persisted Safe Mode boots without the generated extension', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-se-g-'))
    const { first, created, human } = await prepareCandidate(home)
    try {
      await first.recoveryRoot.activate(created.id, human)
      await first.recoveryRoot.enterSafeMode(human)
    } finally {
      await first.ctx.fiber.dispose()
    }
    const second = await bootAssistantControl({ home })
    try {
      assert.equal(second.diagnostics.safeMode, true)
      assert.equal(second.ctx.tools.get('restart_probe_ping'), undefined)
      assert.ok(second.recoveryRoot.inspect())
      second.recoveryRoot.exitSafeMode(second.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'operator-cli' }))
      assert.equal(second.recoveryRoot.inspect().safeMode, false)
    } finally {
      await second.ctx.fiber.dispose()
    }
  })

  it('H. missing active artifact fails closed into recovery', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-se-h-'))
    const { first, created, human } = await prepareCandidate(home)
    try {
      await first.recoveryRoot.activate(created.id, human)
    } finally {
      await first.ctx.fiber.dispose()
    }
    rmSync(join(home, 'self-extension', 'candidates', created.id), { recursive: true, force: true })
    const second = await bootAssistantControl({ home })
    try {
      assert.equal(second.diagnostics.safeMode, true)
      assert.match(second.diagnostics.reasons.join('\n'), /missing-active-artifact/)
      assert.equal(second.ctx.tools.get('restart_probe_ping'), undefined)
    } finally {
      await second.ctx.fiber.dispose()
    }
  })

  it('I. corrupt persistence does not auto-activate and leaves recovery available', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-se-i-'))
    mkdirSync(join(home, 'self-extension'), { recursive: true })
    writeFileSync(join(home, 'self-extension', 'authority.json'), '{"schemaVersion":99}\n')
    const booted = await bootAssistantControl({ home })
    try {
      assert.equal(booted.diagnostics.persistence, 'unknown-schema')
      assert.equal(booted.diagnostics.recoveryRequired, true)
      assert.ok(booted.recoveryRoot.inspect())
      assert.equal(booted.ctx.tools.get('restart_probe_ping'), undefined)
    } finally {
      await booted.ctx.fiber.dispose()
    }
  })

  it('K. retired artifact remaining on disk has no authority', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-se-k-'))
    const { first, created, human } = await prepareCandidate(home)
    try {
      await first.recoveryRoot.activate(created.id, human)
      await first.recoveryRoot.disable(human, 'generated/restart-probe', '0.1.0')
    } finally {
      await first.ctx.fiber.dispose()
    }
    const second = await bootAssistantControl({ home })
    try {
      assert.equal(second.ctx.tools.get('restart_probe_ping'), undefined)
      assert.notEqual(second.ctx.capabilityRegistry.get('generated/restart-probe', '0.1.0')?.status, 'active')
    } finally {
      await second.ctx.fiber.dispose()
    }
  })

  it('L. model-facing seams cannot approve, activate, rewrite LKG, or exit Safe Mode', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-se-l-'))
    const { first } = await prepareCandidate(home)
    try {
      assert.equal((first.ctx.extensionRecovery as { exitSafeMode?: unknown }).exitSafeMode, undefined)
      assert.throws(() => first.ctx.extensionGovernance.recordUntrustedApproval({ approved: true }))
      assert.throws(() => first.ctx.extensionGovernance.rewriteRecoveryRoot())
      const status = operatorStatus({
        activation: first.recoveryRoot.inspect(),
        registry: [...first.ctx.capabilityRegistry.list()],
        candidates: [...first.ctx.candidateWorkspace.list()],
      })
      assert.match(formatOperatorStatus(status), /mode:/)
    } finally {
      await first.ctx.fiber.dispose()
    }
  })

  it('upgrades a pre-contract generated home without Safe Mode and requires reapproval', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-se-upgrade-'))
    const { first, created, human, fingerprint } = await prepareCandidate(home)
    const secondCandidate = await prepareSecondCandidate(first)
    try {
      await first.recoveryRoot.activate(created.id, human)
      await first.recoveryRoot.activate(secondCandidate.created.id, secondCandidate.human)
    } finally {
      await first.ctx.fiber.dispose()
    }
    downgradePersistedContractToMain6998205(home, created.id)
    const upgraded = await bootAssistantControl({ home })
    try {
      assert.equal(upgraded.diagnostics.safeMode, false)
      assert.equal(upgraded.recoveryRoot.inspect().safeMode, false)
      assert.notEqual(upgraded.ctx.capabilityRegistry.get('generated/restart-probe', '0.1.0')?.status, 'active')
      assert.equal(upgraded.ctx.capabilityRegistry.get('generated/restart-probe-b', '0.1.0')?.status, 'active')
      assert.equal(upgraded.ctx.tools.get('restart_probe_ping'), undefined)
      assert.ok(upgraded.ctx.tools.get('restart_probe_alt'))
      assert.match(upgraded.recoveryRoot.inspect().lastFailure?.diagnostics ?? '', /legacy-authoring-contract/)
      assert.match(upgraded.recoveryRoot.inspect().lastFailure?.diagnostics ?? '', /migrate-authoring-contract/)
      const withheld = upgraded.recoveryRoot.inspect()
      assert.equal(withheld.integrityVerified, true)
      assert.equal(withheld.recoveryRequired, false)
      assertSnapshotsMatchActiveRegistry(withheld, upgraded.ctx.capabilityRegistry)
      assert.equal(activeOwnerKeys(withheld.lastKnownGood).includes('generated/restart-probe@0.1.0'), false)
      const migrated = upgraded.recoveryRoot.migrateAuthoringContract(
        upgraded.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'operator-cli' }),
        created.id,
      )
      assert.equal(migrated.manifest.runtimeContractVersion, GENERATED_EXTENSION_API_V1)
      assert.notEqual(migrated.id, created.id)
      assert.notEqual(migrated.digest, created.digest)
      assert.equal(upgraded.ctx.extensionGovernance.inspectApproval(migrated.id), undefined)
      const operator = upgraded.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'operator-cli' })
      assert.throws(() => upgraded.recoveryRoot.recordApproval(operator, {
        candidateId: migrated.id,
        fingerprint,
        decision: 'approved-for-exact-diff',
      }), /fingerprint/)
      upgraded.ctx.independentReview.reviewCandidate(migrated.id)
      const requested = upgraded.ctx.extensionGovernance.requestApproval(migrated.id)
      assert.notEqual(requested.fingerprint, fingerprint)
      upgraded.recoveryRoot.recordApproval(operator, {
        candidateId: migrated.id,
        fingerprint: requested.fingerprint,
        decision: 'approved-for-exact-diff',
      })
      const activated = await upgraded.recoveryRoot.activate(migrated.id, operator)
      assert.equal(activated.state, 'active', activated.lastFailure?.diagnostics)
      assert.equal(await ping(upgraded.ctx), 'pong')
      const rolled = await upgraded.recoveryRoot.rollback(operator)
      assert.equal(rolled.state, 'rolled-back', rolled.lastFailure?.diagnostics)
      assert.equal(rolled.safeMode, false)
      assert.equal(rolled.integrityVerified, true)
      assert.equal(rolled.recoveryRequired, false)
      assert.equal(upgraded.ctx.tools.get('restart_probe_ping'), undefined)
      assert.ok(upgraded.ctx.tools.get('restart_probe_alt'))
      assert.notEqual(upgraded.ctx.capabilityRegistry.get('generated/restart-probe', '0.1.0')?.status, 'active')
      assert.notEqual(upgraded.ctx.capabilityRegistry.get(migrated.owner, migrated.version)?.status, 'active')
      assert.equal(upgraded.ctx.capabilityRegistry.get('generated/restart-probe-b', '0.1.0')?.status, 'active')
      assertSnapshotsMatchActiveRegistry(rolled, upgraded.ctx.capabilityRegistry)
      assert.equal(activeOwnerKeys(rolled.lastKnownGood).includes('generated/restart-probe@0.1.0'), false)
      assert.equal(activeOwnerKeys(rolled.current).includes(`${migrated.owner}@${migrated.version}`), false)
    } finally {
      await upgraded.ctx.fiber.dispose()
    }
  })

  it('rejects an unknown future authority schema', () => {
    assert.throws(() => {
      throw new PersistenceSchemaError('unsupported self-extension schema 99')
    }, PersistenceSchemaError)
  })
})

/** Replay main `6998205` persistence: generated records had no host contract field. */
function downgradePersistedContractToMain6998205(home: string, candidateId: string): void {
  const paths = selfExtensionPaths(home)
  const index = JSON.parse(readFileSync(paths.candidateIndexPath, 'utf8')) as {
    candidates: { record: { id: string; digest?: string; manifest: Record<string, unknown>; validation?: { digest?: string } } }[]
  }
  const row = index.candidates.find((item) => item.record.id === candidateId)
  assert.ok(row)
  delete row.record.manifest.runtimeContractVersion
  const artifact = join(paths.candidateArea, candidateId)
  const manifestPath = join(artifact, 'candidate.manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  delete manifest.runtimeContractVersion
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const stamp = join(artifact, 'generated-extension-api.json')
  if (existsSync(stamp)) rmSync(stamp)
  const digest = digestFiles(artifact, listSourceFiles(artifact))
  row.record.digest = digest
  if (row.record.validation) row.record.validation.digest = digest
  writeFileSync(paths.candidateIndexPath, `${JSON.stringify(index, null, 2)}\n`)
}

function activeOwnerKeys(snapshot?: { owners: readonly { owner: string; version: string; status: string }[] }): string[] {
  return (snapshot?.owners ?? [])
    .filter((item) => item.status === 'active')
    .map((item) => `${item.owner}@${item.version}`)
    .sort()
}

function assertSnapshotsMatchActiveRegistry(
  status: {
    current?: { owners: readonly { owner: string; version: string; status: string }[] }
    lastKnownGood?: { owners: readonly { owner: string; version: string; status: string }[] }
    rollbackTarget?: { owners: readonly { owner: string; version: string; status: string }[] }
  },
  registry: { list(): readonly { owner: string; version: string; status: string }[] },
): void {
  const active = registry.list()
    .filter((item) => item.status === 'active')
    .map((item) => `${item.owner}@${item.version}`)
    .sort()
  assert.deepEqual(activeOwnerKeys(status.current), active)
  assert.deepEqual(activeOwnerKeys(status.lastKnownGood), active)
  assert.deepEqual(activeOwnerKeys(status.rollbackTarget), active)
}
