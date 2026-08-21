import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SimulatedCrashError } from '../src/domain/governance/index.js'
import { PersistenceSchemaError, formatOperatorStatus, operatorStatus } from '../src/domain/self-extension/index.js'
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
  const human = first.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'application-ui' })
  const fingerprint = first.ctx.extensionGovernance.requestApproval(created.id).fingerprint
  first.recoveryRoot.recordApproval(human, { candidateId: created.id, fingerprint, decision: 'approved-for-exact-diff' })
  return { first, created, human, fingerprint }
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
      first.recoveryRoot.enterSafeMode(human)
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
      first.recoveryRoot.disable(human, 'generated/restart-probe', '0.1.0')
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

  it('rejects an unknown future authority schema', () => {
    assert.throws(() => {
      throw new PersistenceSchemaError('unsupported self-extension schema 99')
    }, PersistenceSchemaError)
  })
})
