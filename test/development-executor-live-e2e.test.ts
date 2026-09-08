import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { ClaudeCodeDevelopmentExecutor, CodexDevelopmentExecutor } from '../src/adapters/development-executor/local-cli.js'
import { JsonFileDevelopmentRunStore } from '../src/adapters/development-executor/json-file-run-store.js'
import type { CandidateRecord, CandidateWorkspace } from '../src/domain/candidate/index.js'
import { DevelopmentExecutorService, type ExternalDevelopmentExecutorId } from '../src/domain/development-executor/index.js'
import type { CandidateWorkbench } from '../src/domain/workbench/index.js'

const live = process.env.TARS_NG_LIVE_DEVELOPMENT_EXECUTORS === '1'

describe('live external Development Executor acceptance', { skip: !live }, () => {
  for (const executorId of ['codex', 'claude-code'] as const) {
    it(`${executorId} authors only inside a governed Candidate Workspace`, { timeout: 6 * 60_000 }, async () => {
      const fixture = setup(executorId)
      try {
        const executor = executorId === 'codex'
          ? new CodexDevelopmentExecutor({ timeoutMs: 4 * 60_000 })
          : new ClaudeCodeDevelopmentExecutor({ timeoutMs: 4 * 60_000 })
        const availability = executor.inspect()
        assert.equal(availability.available, true, availability.detail)
        assert.equal(availability.executionReady, true, `${availability.label} must have a usable execution route before live acceptance`)
        const hub = new DevelopmentExecutorService(
          fixture.workspace,
          fixture.workbench,
          [executor],
          new JsonFileDevelopmentRunStore(fixture.runRoot),
        )
        const result = await hub.develop({
          candidateId: fixture.record.id,
          executor: executorId,
          instructions: `Create src/acceptance.js containing exactly: export const executor = '${executorId}' followed by one newline. Do not change or create anything else.`,
        })
        assert.equal(result.status, 'completed', result.output)
        assert.deepEqual(result.changedFiles, ['src/acceptance.js'])
        assert.equal(readFileSync(path.join(fixture.root, 'src', 'acceptance.js'), 'utf8'), `export const executor = '${executorId}'\n`)
        assert.equal(readFileSync(path.join(fixture.root, 'candidate.manifest.json'), 'utf8'), '{"owner":"generated/live-executor-acceptance"}\n')
      } finally {
        rmSync(fixture.root, { recursive: true, force: true })
        rmSync(fixture.runRoot, { recursive: true, force: true })
      }
    })
  }
})

function setup(executor: ExternalDevelopmentExecutorId) {
  const root = mkdtempSync(path.join(tmpdir(), `tars-live-${executor}-`))
  const runRoot = mkdtempSync(path.join(tmpdir(), `tars-live-${executor}-runs-`))
  mkdirSync(path.join(root, 'src'), { recursive: true })
  writeFileSync(path.join(root, 'candidate.manifest.json'), '{"owner":"generated/live-executor-acceptance"}\n')
  const record = {
    id: `generated--live-executor-acceptance-${executor}@0.1.0`,
    owner: 'generated/live-executor-acceptance',
    version: '0.1.0',
    provenance: { kind: 'generated', origin: 'assistant' },
    lifecycle: 'developing',
    workspaceRoot: root,
    manifest: {},
    sealed: false,
  } as unknown as CandidateRecord
  const workspace = {
    get: () => record,
    refresh: () => record,
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
      resolutionCapability: 'acceptance.external-development',
      planId: 'plan-live',
      requestEligibility: { ok: false, denials: [] },
      step: 'author',
      leftover: false,
      specification: {
        id: 'spec-live',
        goal: 'Prove that an authenticated external executor can author one bounded Candidate source file.',
      },
    }),
    getPlan: () => ({ id: 'plan-live', acceptance: { sessionId: 'live-acceptance', acceptedAt: new Date().toISOString() } }),
    inspectAuthoringContract: () => ({ version: 'generated-extension-api/v1' }),
  } as unknown as CandidateWorkbench
  return { root, runRoot, record, workspace, workbench }
}
