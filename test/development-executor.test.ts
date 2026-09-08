import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import type { CandidateRecord, CandidateWorkspace } from '../src/domain/candidate/index.js'
import {
  DevelopmentExecutorContractError,
  DevelopmentExecutorService,
  type DevelopmentExecution,
  type DevelopmentExecutor,
  type DevelopmentTask,
} from '../src/domain/development-executor/index.js'
import type { CandidateWorkbench } from '../src/domain/workbench/index.js'
import { ClaudeCodeDevelopmentExecutor, CodexDevelopmentExecutor } from '../src/adapters/development-executor/local-cli.js'
import { JsonFileDevelopmentRunStore } from '../src/adapters/development-executor/json-file-run-store.js'

class FakeExecutor implements DevelopmentExecutor {
  readonly id = 'codex' as const
  readonly label = 'Codex'
  constructor(private readonly edit: (task: DevelopmentTask) => void, private readonly exitCode = 0) {}
  inspect() { return { id: this.id, label: this.label, available: true, executionReady: true, authenticated: true, route: 'provider-account' as const, native: false, detail: 'test', verification: 'authenticated' as const } }
  async execute(task: DevelopmentTask): Promise<DevelopmentExecution> {
    this.edit(task)
    return { exitCode: this.exitCode, termination: 'exited', output: 'executor output', truncated: false, durationMs: 12 }
  }
}

describe('development executors', () => {
  it('keeps TARS-NG Native as the default path and commits bounded external edits', async () => {
    const fixture = setup()
    const hub = new DevelopmentExecutorService(fixture.workspace, fixture.workbench, [
      new FakeExecutor((task) => writeFileSync(path.join(task.workspaceRoot, 'index.js'), 'export const changed = true\n')),
    ])

    assert.deepEqual(hub.inspect().map((item) => item.id), ['native', 'codex'])
    assert.equal(hub.inspect()[0]?.available, true)
    const run = await hub.develop({ candidateId: fixture.record.id, executor: 'codex' })
    assert.equal(run.status, 'completed')
    assert.deepEqual(run.changedFiles, ['index.js'])
    assert.equal(run.rolledBack, false)
    assert.equal(fixture.refreshes(), 1)
    assert.match(readFileSync(path.join(fixture.root, 'index.js'), 'utf8'), /changed = true/)
  })

  it('rolls back failed execution and any attempted manifest mutation', async () => {
    const failed = setup()
    const failingHub = new DevelopmentExecutorService(failed.workspace, failed.workbench, [
      new FakeExecutor((task) => writeFileSync(path.join(task.workspaceRoot, 'index.js'), 'broken\n'), 1),
    ])
    const run = await failingHub.develop({ candidateId: failed.record.id, executor: 'codex' })
    assert.equal(run.status, 'failed')
    assert.equal(run.rolledBack, true)
    assert.equal(readFileSync(path.join(failed.root, 'index.js'), 'utf8'), 'original\n')

    const manifest = setup()
    const manifestHub = new DevelopmentExecutorService(manifest.workspace, manifest.workbench, [
      new FakeExecutor((task) => writeFileSync(path.join(task.workspaceRoot, 'candidate.manifest.json'), '{}\n')),
    ])
    await assert.rejects(
      manifestHub.develop({ candidateId: manifest.record.id, executor: 'codex' }),
      (error: unknown) => error instanceof DevelopmentExecutorContractError && /cannot change host-owned/.test(error.message),
    )
    assert.equal(readFileSync(path.join(manifest.root, 'candidate.manifest.json'), 'utf8'), '{"owner":"generated/test"}\n')
  })

  it('requires an explicitly accepted Resolution Plan', async () => {
    const fixture = setup(false)
    const hub = new DevelopmentExecutorService(fixture.workspace, fixture.workbench, [new FakeExecutor(() => {})])
    await assert.rejects(
      hub.develop({ candidateId: fixture.record.id, executor: 'codex' }),
      /must be explicitly accepted/,
    )
  })

  it('distinguishes an installed CLI from an authenticated executor', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tars-dev-auth-'))
    const executable = path.join(root, 'fake-cli')
    writeFileSync(executable, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "fake 1.0"; exit 0; fi',
      'if [ "$1" = "login" ]; then echo "Not logged in"; exit 1; fi',
      'exit 1',
    ].join('\n'))
    chmodSync(executable, 0o700)
    const executor = new CodexDevelopmentExecutor({ executable, env: { HOME: root, PATH: process.env.PATH } })
    assert.deepEqual(executor.inspect(), {
      id: 'codex',
      label: 'Codex',
      available: true,
      executionReady: false,
      authenticated: false,
      route: 'provider-account',
      native: false,
      detail: 'fake 1.0',
      verification: 'authentication-failed',
    })
    const fixture = setup()
    const hub = new DevelopmentExecutorService(fixture.workspace, fixture.workbench, [executor])
    await assert.rejects(hub.develop({ candidateId: fixture.record.id, executor: 'codex' }), /no usable execution route/)
  })

  it('recognizes a configured Claude custom model route without requiring Anthropic login', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tars-dev-claude-route-'))
    const executable = path.join(root, 'fake-claude')
    const settingsFile = path.join(root, 'settings.json')
    writeFileSync(settingsFile, JSON.stringify({
      model: 'local-model',
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999', ANTHROPIC_AUTH_TOKEN: 'fixture-token' },
    }))
    writeFileSync(executable, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "fake claude 1.0"; exit 0; fi',
      'if [ "$1" = "auth" ]; then echo \'{"loggedIn":false}\'; exit 1; fi',
      'printf "ARGS:%s\\n" "$*"',
      'cat > prompt.txt',
    ].join('\n'))
    chmodSync(executable, 0o700)
    const executor = new ClaudeCodeDevelopmentExecutor({ executable, settingsFile, env: { HOME: root, PATH: process.env.PATH } })
    const availability = executor.inspect()
    assert.equal(String(availability.verification), 'custom-route-configured')
    assert.equal(availability.authenticated, false)
    assert.equal(availability.executionReady, true)
    assert.equal(availability.route, 'custom-provider')
    const result = await executor.execute({
      runId: 'dev-00000000-0000-4000-8000-000000000020',
      candidateId: 'candidate',
      workspaceRoot: root,
      prompt: 'bounded prompt',
    })
    assert.match(result.output, new RegExp(`--settings ${settingsFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  })

  it('invokes both CLIs non-interactively without forwarding unrelated host secrets', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tars-dev-cli-'))
    const executable = path.join(root, 'fake-cli')
    writeFileSync(executable, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "fake 1.0"; exit 0; fi',
      'if [ "$1" = "login" ]; then echo "Logged in using test"; exit 0; fi',
      'if [ "$1" = "auth" ]; then echo \'{"loggedIn":true}\'; exit 0; fi',
      'printf "ARGS:%s\\n" "$*"',
      'printf "SECRET:%s\\n" "${TARS_TEST_SECRET-unset}"',
      'cat > prompt.txt',
      'printf "export const authored = true\\n" > authored.js',
    ].join('\n'))
    chmodSync(executable, 0o700)
    const env = { HOME: root, PATH: process.env.PATH, TARS_TEST_SECRET: 'must-not-leak' }
    const task = { runId: 'dev-00000000-0000-4000-8000-000000000000', candidateId: 'candidate', workspaceRoot: root, prompt: 'bounded prompt' }

    const codex = new CodexDevelopmentExecutor({ executable, env })
    assert.equal(codex.inspect().available, true)
    const codexRun = await codex.execute(task)
    assert.equal(codexRun.exitCode, 0)
    assert.match(codexRun.output, /--approve-for-me/)
    assert.doesNotMatch(codexRun.output, /dangerously-bypass/)
    assert.match(codexRun.output, /SECRET:unset/)

    const claude = new ClaudeCodeDevelopmentExecutor({ executable, env })
    assert.equal(claude.inspect().available, true)
    const claudeRun = await claude.execute(task)
    assert.equal(claudeRun.exitCode, 0)
    assert.match(claudeRun.output, /--restricted/)
    assert.match(claudeRun.output, /--tools Read,Write,Edit,Glob,Grep/)
    assert.equal(readFileSync(path.join(root, 'prompt.txt'), 'utf8'), 'bounded prompt')
  })

  it('terminates a timed-out local CLI process group', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tars-dev-timeout-cli-'))
    const executable = path.join(root, 'slow-cli')
    writeFileSync(executable, ['#!/bin/sh', 'sleep 30'].join('\n'))
    chmodSync(executable, 0o700)
    const executor = new CodexDevelopmentExecutor({ executable, timeoutMs: 25, env: { HOME: root, PATH: process.env.PATH } })
    const run = await executor.execute({
      runId: 'dev-00000000-0000-4000-8000-000000000004',
      candidateId: 'candidate',
      workspaceRoot: root,
      prompt: 'bounded prompt',
    })
    assert.equal(run.termination, 'timed-out')
    assert.ok(run.durationMs < 3_000)
  })

  it('terminates only a verified orphan process before restart recovery', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tars-dev-orphan-cli-'))
    const executable = path.join(root, 'orphan-cli')
    writeFileSync(executable, ['#!/bin/sh', 'sleep 30'].join('\n'))
    chmodSync(executable, 0o700)
    const child = spawn(executable, [], { detached: true, stdio: 'ignore' })
    await once(child, 'spawn')
    assert.ok(child.pid)
    const executor = new CodexDevelopmentExecutor({ executable })
    const closed = once(child, 'close')
    assert.equal(executor.terminateOrphan({ pid: child.pid, startedAt: new Date().toISOString() }), true)
    await closed
    assert.throws(() => process.kill(child.pid!, 0))
  })

  it('persists progress, cancels the process, and restores the Candidate snapshot', async () => {
    const fixture = setup()
    const store = new JsonFileDevelopmentRunStore(path.join(fixture.root, '..', `runs-${Date.now()}`))
    class BlockingExecutor extends FakeExecutor {
      constructor() { super(() => {}) }
      override async execute(task: DevelopmentTask): Promise<DevelopmentExecution> {
        task.onSpawn?.(4242)
        writeFileSync(path.join(task.workspaceRoot, 'index.js'), 'partial edit\n')
        task.onProgress?.(2048)
        await new Promise<void>((resolve) => task.signal?.addEventListener('abort', () => resolve(), { once: true }))
        return { exitCode: null, termination: 'cancelled', output: 'cancelled', truncated: false, durationMs: 25 }
      }
    }
    const hub = new DevelopmentExecutorService(fixture.workspace, fixture.workbench, [new BlockingExecutor()], store)
    const pending = hub.develop({ candidateId: fixture.record.id, executor: 'codex' })
    await new Promise((resolve) => setImmediate(resolve))
    const running = hub.runs()[0]!
    assert.equal(running.status, 'running')
    assert.equal(running.pid, 4242)
    hub.cancel(running.runId)
    assert.equal(hub.runs()[0]?.status, 'cancelling')
    const result = await pending
    assert.equal(result.status, 'cancelled')
    assert.equal(result.rolledBack, true)
    assert.equal(readFileSync(path.join(fixture.root, 'index.js'), 'utf8'), 'original\n')
    assert.equal(hub.runs()[0]?.progressBytes, 2048)
  })

  it('recovers a persisted interrupted run and its pre-run Candidate snapshot', () => {
    const fixture = setup()
    const store = new JsonFileDevelopmentRunStore(path.join(fixture.root, '..', `recovery-${Date.now()}`))
    const runId = 'dev-00000000-0000-4000-8000-000000000001'
    store.stageSnapshot(runId, fixture.root)
    writeFileSync(path.join(fixture.root, 'index.js'), 'orphan edit\n')
    store.save({
      runId,
      candidateId: fixture.record.id,
      executor: 'codex',
      status: 'running',
      startedAt: '2026-09-08T00:00:00.000Z',
      updatedAt: '2026-09-08T00:00:01.000Z',
      pid: 42,
      progressBytes: 10,
      changedFiles: [],
      outputTruncated: false,
      rolledBack: false,
      detail: 'running',
    })
    class RecoveringExecutor extends FakeExecutor {
      recovered = false
      terminateOrphan() { this.recovered = true; return true }
    }
    const executor = new RecoveringExecutor(() => {})
    const hub = new DevelopmentExecutorService(fixture.workspace, fixture.workbench, [executor], store)
    assert.equal(executor.recovered, true)
    assert.equal(hub.runs()[0]?.status, 'interrupted')
    assert.equal(hub.runs()[0]?.rolledBack, true)
    assert.equal(readFileSync(path.join(fixture.root, 'index.js'), 'utf8'), 'original\n')
  })

  it('records timeouts and restores the Candidate snapshot', async () => {
    const fixture = setup()
    class TimeoutExecutor extends FakeExecutor {
      constructor() { super(() => {}) }
      override async execute(task: DevelopmentTask): Promise<DevelopmentExecution> {
        task.onSpawn?.(4343)
        writeFileSync(path.join(task.workspaceRoot, 'index.js'), 'timed out edit\n')
        task.onProgress?.(512)
        return { exitCode: null, termination: 'timed-out', output: 'deadline exceeded', truncated: false, durationMs: 15 * 60_000 }
      }
    }
    const hub = new DevelopmentExecutorService(fixture.workspace, fixture.workbench, [new TimeoutExecutor()])
    const result = await hub.develop({ candidateId: fixture.record.id, executor: 'codex' })
    assert.equal(result.status, 'timed-out')
    assert.equal(result.rolledBack, true)
    assert.equal(readFileSync(path.join(fixture.root, 'index.js'), 'utf8'), 'original\n')
    assert.match(hub.runs()[0]?.detail ?? '', /Timed out/)
  })

  it('downgrades authentication after a real run reports an authentication failure', async () => {
    const fixture = setup()
    class AuthFailureExecutor extends FakeExecutor {
      constructor() { super(() => {}, 1) }
      override async execute(task: DevelopmentTask): Promise<DevelopmentExecution> {
        writeFileSync(path.join(task.workspaceRoot, 'index.js'), 'partial\n')
        return { exitCode: 1, termination: 'exited', output: 'Not logged in · Please run /login', truncated: false, durationMs: 10 }
      }
    }
    const hub = new DevelopmentExecutorService(fixture.workspace, fixture.workbench, [new AuthFailureExecutor()])
    assert.equal((await hub.develop({ candidateId: fixture.record.id, executor: 'codex' })).status, 'failed')
    const status = hub.inspect().find((item) => item.id === 'codex')
    assert.equal(status?.authenticated, false)
    assert.equal(status?.executionReady, false)
    assert.equal(status?.verification, 'authentication-failed')
    assert.match(status?.detail ?? '', /most recent Development Run/)
  })

  it('validates a persisted snapshot completely before replacing the Candidate workspace', () => {
    const fixture = setup()
    const storeRoot = path.join(fixture.root, '..', `corrupt-${Date.now()}`)
    const store = new JsonFileDevelopmentRunStore(storeRoot)
    const runId = 'dev-00000000-0000-4000-8000-000000000002'
    store.stageSnapshot(runId, fixture.root)
    writeFileSync(path.join(storeRoot, 'snapshots', `${runId}.json`), JSON.stringify({
      version: 1,
      files: {
        'index.js': Buffer.from('restored\n').toString('base64'),
        '../escape': Buffer.from('unsafe\n').toString('base64'),
      },
    }))
    writeFileSync(path.join(fixture.root, 'index.js'), 'must survive\n')
    assert.throws(() => store.restoreSnapshot(runId, fixture.root), /invalid Development Run snapshot entry/)
    assert.equal(readFileSync(path.join(fixture.root, 'index.js'), 'utf8'), 'must survive\n')
  })

  it('freezes a Candidate when an interrupted run cannot be proven terminated', async () => {
    const fixture = setup()
    const store = new JsonFileDevelopmentRunStore(path.join(fixture.root, '..', `frozen-${Date.now()}`))
    const runId = 'dev-00000000-0000-4000-8000-000000000003'
    store.stageSnapshot(runId, fixture.root)
    store.save({
      runId,
      candidateId: fixture.record.id,
      executor: 'codex',
      status: 'running',
      startedAt: '2026-09-08T00:00:00.000Z',
      updatedAt: '2026-09-08T00:00:01.000Z',
      pid: 42,
      progressBytes: 0,
      changedFiles: [],
      outputTruncated: false,
      rolledBack: false,
      detail: 'running',
    })
    class UnverifiedOrphanExecutor extends FakeExecutor { terminateOrphan() { return false } }
    const hub = new DevelopmentExecutorService(fixture.workspace, fixture.workbench, [new UnverifiedOrphanExecutor(() => {})], store)
    assert.equal(hub.runs()[0]?.status, 'interrupted')
    assert.equal(hub.runs()[0]?.rolledBack, false)
    await assert.rejects(hub.develop({ candidateId: fixture.record.id, executor: 'codex' }), /candidate is frozen/)
  })
})

function setup(accepted = true) {
  const root = mkdtempSync(path.join(tmpdir(), 'tars-dev-executor-'))
  mkdirSync(root, { recursive: true })
  writeFileSync(path.join(root, 'candidate.manifest.json'), '{"owner":"generated/test"}\n')
  writeFileSync(path.join(root, 'index.js'), 'original\n')
  const record = {
    id: 'generated--test@0.1.0',
    owner: 'generated/test',
    version: '0.1.0',
    provenance: { kind: 'generated', origin: 'assistant' },
    lifecycle: 'developing',
    workspaceRoot: root,
    manifest: {},
    sealed: false,
  } as unknown as CandidateRecord
  let refreshCount = 0
  const workspace = {
    get: () => record,
    refresh: () => { refreshCount += 1; return record },
  } as unknown as CandidateWorkspace
  const workbench = {
    inspect: () => ({
      id: record.id,
      owner: record.owner,
      version: record.version,
      provenance: record.provenance,
      lifecycle: record.lifecycle,
      sealed: false,
      resolutionKind: 'new-plugin',
      resolutionCapability: 'test.capability',
      planId: 'plan-1',
      requestEligibility: { ok: false, denials: [] },
      step: 'author',
      leftover: false,
      specification: { id: 'spec-1', goal: 'test goal' },
    }),
    getPlan: () => ({ id: 'plan-1', acceptance: accepted ? { sessionId: 'delivery-1', acceptedAt: new Date().toISOString() } : undefined }),
    inspectAuthoringContract: () => ({ version: 'generated-extension-api/v1' }),
  } as unknown as CandidateWorkbench
  return { root, record, workspace, workbench, refreshes: () => refreshCount }
}
