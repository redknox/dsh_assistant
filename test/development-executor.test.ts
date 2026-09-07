import assert from 'node:assert/strict'
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

class FakeExecutor implements DevelopmentExecutor {
  readonly id = 'codex' as const
  readonly label = 'Codex'
  constructor(private readonly edit: (task: DevelopmentTask) => void, private readonly exitCode = 0) {}
  inspect() { return { id: this.id, label: this.label, available: true, native: false, detail: 'test' } }
  async execute(task: DevelopmentTask): Promise<DevelopmentExecution> {
    this.edit(task)
    return { exitCode: this.exitCode, output: 'executor output', truncated: false, durationMs: 12 }
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

  it('invokes both CLIs non-interactively without forwarding unrelated host secrets', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tars-dev-cli-'))
    const executable = path.join(root, 'fake-cli')
    writeFileSync(executable, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "fake 1.0"; exit 0; fi',
      'printf "ARGS:%s\\n" "$*"',
      'printf "SECRET:%s\\n" "${TARS_TEST_SECRET-unset}"',
      'cat > prompt.txt',
      'printf "export const authored = true\\n" > authored.js',
    ].join('\n'))
    chmodSync(executable, 0o700)
    const env = { HOME: root, PATH: process.env.PATH, TARS_TEST_SECRET: 'must-not-leak' }
    const task = { candidateId: 'candidate', workspaceRoot: root, prompt: 'bounded prompt' }

    const codex = new CodexDevelopmentExecutor({ executable, env })
    assert.equal(codex.inspect().available, true)
    const codexRun = await codex.execute(task)
    assert.equal(codexRun.exitCode, 0)
    assert.match(codexRun.output, /--sandbox workspace-write/)
    assert.match(codexRun.output, /SECRET:unset/)

    const claude = new ClaudeCodeDevelopmentExecutor({ executable, env })
    assert.equal(claude.inspect().available, true)
    const claudeRun = await claude.execute(task)
    assert.equal(claudeRun.exitCode, 0)
    assert.match(claudeRun.output, /--restricted/)
    assert.match(claudeRun.output, /--tools Read,Write,Edit,Glob,Grep/)
    assert.equal(readFileSync(path.join(root, 'prompt.txt'), 'utf8'), 'bounded prompt')
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
