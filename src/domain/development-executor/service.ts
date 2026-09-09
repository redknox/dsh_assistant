import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { CandidateWorkspace } from '../candidate/index.js'
import { sanitizeProviderError } from '../integrations/sanitize.js'
import {
  WORKBENCH_MAX_FILE_BYTES,
  WORKBENCH_MAX_FILE_COUNT,
  WORKBENCH_MAX_LIST_DEPTH,
  WORKBENCH_MAX_TRAVERSAL_ENTRIES,
  WORKBENCH_MAX_WORKSPACE_BYTES,
  type CandidateWorkbench,
} from '../workbench/index.js'
import { sanitizeDiagnostic } from '../workbench/diagnostics.js'
import type {
  DevelopmentRun,
  DevelopmentRunStore,
  DevelopmentExecutor,
  DevelopmentExecutorAvailability,
  DevelopmentExecutorHub,
  DevelopmentRunResult,
  ExternalDevelopmentExecutorId,
} from './types.js'

type Snapshot = ReadonlyMap<string, Buffer>

class InMemoryDevelopmentRunStore implements DevelopmentRunStore {
  private readonly runs = new Map<string, DevelopmentRun>()
  private readonly snapshots = new Map<string, Snapshot>()
  list() { return [...this.runs.values()] }
  save(run: DevelopmentRun) { this.runs.set(run.runId, structuredClone(run)) }
  stageSnapshot(runId: string, workspaceRoot: string) { this.snapshots.set(runId, snapshot(workspaceRoot)) }
  restoreSnapshot(runId: string, workspaceRoot: string) {
    const staged = this.snapshots.get(runId)
    if (!staged) throw new DevelopmentExecutorContractError(`development run snapshot is missing: ${runId}`)
    restore(workspaceRoot, staged)
  }
  discardSnapshot(runId: string) { this.snapshots.delete(runId) }
}

export class DevelopmentExecutorContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DevelopmentExecutorContractError'
  }
}

/**
 * One transactional authoring boundary shared by every external coding agent.
 * Candidate validation, approval, activation and rollback remain host-owned.
 */
export class DevelopmentExecutorService implements DevelopmentExecutorHub {
  private readonly executors = new Map<ExternalDevelopmentExecutorId, DevelopmentExecutor>()
  private readonly active = new Map<string, { readonly runId: string; readonly controller: AbortController }>()
  private availabilityCache?: { readonly at: number; readonly value: readonly DevelopmentExecutorAvailability[] }

  constructor(
    private readonly workspace: CandidateWorkspace,
    private readonly workbench: CandidateWorkbench,
    executors: readonly DevelopmentExecutor[],
    private readonly store: DevelopmentRunStore = new InMemoryDevelopmentRunStore(),
    private readonly now: () => Date = () => new Date(),
    recoverInterrupted = true,
  ) {
    for (const executor of executors) this.executors.set(executor.id, executor)
    if (recoverInterrupted) this.recoverInterruptedRuns()
  }

  inspect(): readonly DevelopmentExecutorAvailability[] {
    if (this.availabilityCache && Date.now() - this.availabilityCache.at < 30_000) return this.availabilityCache.value
    const latestExternalRuns = new Map<ExternalDevelopmentExecutorId, DevelopmentRun>()
    for (const run of [...this.store.list()].sort((left, right) => right.startedAt.localeCompare(left.startedAt))) {
      if (!latestExternalRuns.has(run.executor)) latestExternalRuns.set(run.executor, run)
    }
    const value: readonly DevelopmentExecutorAvailability[] = [
      {
        id: 'native',
        label: 'TARS-NG Native',
        available: true,
        executionReady: true,
        native: true,
        detail: 'Built-in candidate authoring tools; default and fallback path.',
        verification: 'built-in',
        authenticated: true,
        route: 'built-in',
      },
      ...[...this.executors.values()].map((executor) => {
        const inspected = executor.inspect()
        const latest = latestExternalRuns.get(executor.id)
        if (latest?.status === 'failed' && isAuthenticationFailure(latest.output)) {
          return {
            ...inspected,
            executionReady: false,
            authenticated: inspected.route === 'provider-account' ? false : inspected.authenticated,
            verification: 'authentication-failed' as const,
            detail: `${executor.label} execution route failed authentication during its most recent Development Run; repair that route before retrying.`,
          }
        }
        return latest?.status === 'completed'
          ? {
              ...inspected,
              executionReady: true,
              verification: 'execution-verified' as const,
              detail: `${inspected.detail}; execution verified by the most recent Development Run.`,
            }
          : inspected
      }),
    ]
    this.availabilityCache = { at: Date.now(), value }
    return value
  }

  runs(input: { readonly candidateId?: string; readonly limit?: number } = {}): readonly DevelopmentRun[] {
    const limit = Math.max(1, Math.min(50, input.limit ?? 10))
    return this.store.list()
      .filter((run) => input.candidateId === undefined || run.candidateId === input.candidateId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .slice(0, limit)
      .map((run) => structuredClone(run))
  }

  cancel(runId: string): DevelopmentRun {
    const run = this.requireRun(runId)
    if (run.status !== 'preparing' && run.status !== 'running') {
      throw new DevelopmentExecutorContractError(`development run is not cancellable: ${run.status}`)
    }
    const active = [...this.active.values()].find((item) => item.runId === runId)
    if (!active) throw new DevelopmentExecutorContractError('development run is no longer owned by this process')
    const next = this.updateRun(run, { status: 'cancelling', detail: 'Cancellation requested; terminating the external executor.' })
    active.controller.abort()
    return next
  }

  shutdown(): void {
    for (const active of this.active.values()) active.controller.abort()
  }

  async develop(input: {
    readonly candidateId: string
    readonly executor: ExternalDevelopmentExecutorId
    readonly instructions?: string
    readonly signal?: AbortSignal
  }): Promise<DevelopmentRunResult> {
    if (input.instructions && Buffer.byteLength(input.instructions, 'utf8') > 16 * 1024) {
      throw new DevelopmentExecutorContractError('development guidance exceeds the 16 KiB limit')
    }
    const executor = this.executors.get(input.executor)
    if (!executor) throw new DevelopmentExecutorContractError(`unknown development executor: ${input.executor}`)
    const available = executor.inspect()
    if (!available.available) throw new DevelopmentExecutorContractError(available.detail)
    if (!available.executionReady) throw new DevelopmentExecutorContractError(`${executor.label} is installed but has no usable execution route`)
    if (this.active.has(input.candidateId)) throw new DevelopmentExecutorContractError('candidate already has an active development executor')
    const unresolved = this.store.list().find((run) => run.candidateId === input.candidateId && run.status === 'interrupted' && !run.rolledBack)
    if (unresolved) {
      throw new DevelopmentExecutorContractError(`candidate is frozen after interrupted Development Run ${unresolved.runId}; restore its snapshot before retrying`)
    }

    const candidate = this.workspace.get(input.candidateId)
    if (candidate.sealed) throw new DevelopmentExecutorContractError('sealed candidates cannot be edited by a development executor')
    if (candidate.lifecycle !== 'planned' && candidate.lifecycle !== 'developing') {
      throw new DevelopmentExecutorContractError('external development requires a planned or developing candidate; repair validated revisions first')
    }
    const view = this.workbench.inspect(candidate.id)
    if (!view.planId || !this.workbench.getPlan(view.planId).acceptance) {
      throw new DevelopmentExecutorContractError('the candidate Resolution Plan must be explicitly accepted before external development')
    }

    const before = snapshot(candidate.workspaceRoot)
    const manifestBefore = before.get('candidate.manifest.json')
    if (!manifestBefore) throw new DevelopmentExecutorContractError('candidate manifest is missing')
    const runId = `dev-${randomUUID()}`
    const controller = new AbortController()
    const forwardAbort = () => controller.abort()
    input.signal?.addEventListener('abort', forwardAbort, { once: true })
    if (input.signal?.aborted) controller.abort()
    let run: DevelopmentRun = {
      runId,
      candidateId: candidate.id,
      executor: input.executor,
      status: 'preparing',
      startedAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      progressBytes: 0,
      changedFiles: [],
      outputTruncated: false,
      rolledBack: false,
      detail: 'Capturing a transactional Candidate Workspace snapshot.',
    }
    this.store.save(run)
    try {
      this.store.stageSnapshot(runId, candidate.workspaceRoot)
    } catch (error) {
      this.updateRun(run, {
        status: 'failed',
        finishedAt: this.now().toISOString(),
        detail: 'Could not capture a safe Candidate snapshot; the external executor was not started.',
      })
      throw new DevelopmentExecutorContractError(error instanceof Error ? error.message : 'could not capture Candidate snapshot')
    }
    this.active.set(candidate.id, { runId, controller })
    let progressBytes = 0
    let lastProgressSave = 0
    try {
      const execution = await executor.execute({
        runId,
        candidateId: candidate.id,
        workspaceRoot: candidate.workspaceRoot,
        prompt: taskPrompt(view, this.workbench.inspectAuthoringContract(view.contractVersion), input.instructions),
        signal: controller.signal,
        onSpawn: (pid) => {
          const current = this.requireRun(runId)
          run = this.updateRun(current, {
            ...(current.status === 'cancelling' ? {} : { status: 'running' as const }),
            pid,
            detail: current.status === 'cancelling'
              ? 'Cancellation requested; terminating the external executor.'
              : `${executor.label} is editing the bounded Candidate Workspace.`,
          })
        },
        onProgress: (bytes) => {
          progressBytes += bytes
          if (Date.now() - lastProgressSave < 500) return
          lastProgressSave = Date.now()
          run = this.updateRun(this.requireRun(runId), { progressBytes })
        },
      })
      if (execution.exitCode !== 0 || execution.termination !== 'exited') {
        this.store.restoreSnapshot(runId, candidate.workspaceRoot)
        this.store.discardSnapshot(runId)
        const status = execution.termination === 'timed-out' ? 'timed-out' : execution.termination === 'cancelled' ? 'cancelled' : 'failed'
        run = this.finishRun(this.requireRun(runId), status, execution, [], true, progressBytes)
        return resultFromRun(run)
      }

      let after: Snapshot
      try {
        after = snapshot(candidate.workspaceRoot)
        const protectedChanges = changed(before, after).filter(isHostOwnedArtifact)
        if (protectedChanges.length > 0) {
          throw new DevelopmentExecutorContractError(`external executors cannot change host-owned candidate artifacts: ${protectedChanges.join(', ')}`)
        }
      } catch (error) {
        restore(candidate.workspaceRoot, before)
        throw error
      }
      const changedFiles = changed(before, after).filter((file) => file !== 'candidate.manifest.json')
      this.workspace.refresh(candidate.id)
      run = this.finishRun(this.requireRun(runId), 'completed', execution, changedFiles, false, progressBytes)
      this.store.discardSnapshot(runId)
      return resultFromRun(run)
    } catch (error) {
      let rolledBack = false
      try {
        this.store.restoreSnapshot(runId, candidate.workspaceRoot)
        this.store.discardSnapshot(runId)
        rolledBack = true
      } catch {
        rolledBack = false
      }
      const execution = { exitCode: null, termination: controller.signal.aborted ? 'cancelled' as const : 'exited' as const, output: error instanceof Error ? error.message : String(error), truncated: false, durationMs: Date.now() - Date.parse(run.startedAt) }
      run = this.finishRun(this.requireRun(runId), controller.signal.aborted ? 'cancelled' : 'failed', execution, [], rolledBack, progressBytes)
      if (error instanceof DevelopmentExecutorContractError) throw error
      throw new DevelopmentExecutorContractError(error instanceof Error ? error.message : 'development executor failed')
    } finally {
      input.signal?.removeEventListener('abort', forwardAbort)
      this.active.delete(candidate.id)
    }
  }

  private requireRun(runId: string): DevelopmentRun {
    const run = this.store.list().find((item) => item.runId === runId)
    if (!run) throw new DevelopmentExecutorContractError(`unknown development run: ${runId}`)
    return run
  }

  private updateRun(run: DevelopmentRun, patch: Partial<DevelopmentRun>): DevelopmentRun {
    const next = { ...run, ...patch, updatedAt: this.now().toISOString() }
    this.store.save(next)
    return next
  }

  private finishRun(
    run: DevelopmentRun,
    status: Extract<DevelopmentRun['status'], 'completed' | 'failed' | 'cancelled' | 'timed-out'>,
    execution: { readonly output: string; readonly truncated: boolean; readonly durationMs: number },
    changedFiles: readonly string[],
    rolledBack: boolean,
    progressBytes: number,
  ): DevelopmentRun {
    this.availabilityCache = undefined
    const finishedAt = this.now().toISOString()
    return this.updateRun(run, {
      status,
      finishedAt,
      progressBytes,
      changedFiles,
      durationMs: execution.durationMs,
      output: sanitizeDevelopmentOutput(execution.output),
      outputTruncated: execution.truncated,
      rolledBack,
      detail: status === 'completed'
        ? `Completed with ${changedFiles.length} changed file${changedFiles.length === 1 ? '' : 's'}; ready for TARS-NG validation.`
        : status === 'timed-out'
          ? 'Timed out; the external process was terminated and Candidate changes were rolled back.'
          : status === 'cancelled'
            ? 'Cancelled; Candidate changes were rolled back.'
            : 'Failed; Candidate changes were rolled back.',
    })
  }

  private recoverInterruptedRuns(): void {
    for (const run of this.store.list()) {
      if (!['preparing', 'running', 'cancelling'].includes(run.status)) continue
      const candidate = (() => { try { return this.workspace.get(run.candidateId) } catch { return undefined } })()
      const executor = this.executors.get(run.executor)
      const terminated = run.pid === undefined || executor?.terminateOrphan?.(run) === true
      let rolledBack = false
      if (candidate && terminated) {
        try {
          this.store.restoreSnapshot(run.runId, candidate.workspaceRoot)
          rolledBack = true
          this.store.discardSnapshot(run.runId)
        } catch {
          rolledBack = false
        }
      }
      this.store.save({
        ...run,
        status: 'interrupted',
        updatedAt: this.now().toISOString(),
        finishedAt: this.now().toISOString(),
        rolledBack,
        detail: terminated
          ? rolledBack ? 'Host restart interrupted this run; the orphan was terminated and Candidate snapshot restored.' : 'Host restart interrupted this run; snapshot recovery requires operator attention.'
          : 'Host restart found an unverified external process; Candidate is frozen for operator recovery.',
      })
    }
  }
}

function sanitizeDevelopmentOutput(output: string): string {
  const credentialsRemoved = output
    .replace(/authorization\s*[:=]\s*(?:bearer\s+)?\S+/gi, 'Authorization: [redacted]')
    .replace(/\b[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|PASSWORD)\s*=\s*\S+/gi, '[redacted]')
  return sanitizeDiagnostic(sanitizeProviderError(credentialsRemoved))
}

function isHostOwnedArtifact(relativePath: string): boolean {
  return relativePath === 'candidate.manifest.json'
    || relativePath === 'capability-specification.json'
    || relativePath === 'generated-extension-api.json'
    || relativePath === '.dsh'
    || relativePath.startsWith('.dsh/')
}

function isAuthenticationFailure(output: string | undefined): boolean {
  return typeof output === 'string' && /authentication_failed|not logged in|unauthorized|invalid api key/i.test(output)
}

function taskPrompt(
  candidate: ReturnType<CandidateWorkbench['inspect']>,
  contract: ReturnType<CandidateWorkbench['inspectAuthoringContract']>,
  extra?: string,
): string {
  return [
    'You are a bounded implementation executor working for TARS-NG.',
    `Implement candidate ${candidate.id} in the current directory.`,
    'Treat the supplied specification and generated-extension-api/v1 contract as authoritative.',
    'You may edit candidate source and test files only. Do not edit candidate.manifest.json.',
    'Do not use git, install dependencies, access unrelated paths, request approval, activate, publish, push, or merge.',
    'Keep the implementation small and deterministic. TARS-NG will run its own validation and governance after you finish.',
    `Specification:\n${JSON.stringify(candidate.specification ?? null, null, 2)}`,
    `Authoring contract:\n${JSON.stringify(contract, null, 2)}`,
    `Current candidate:\n${JSON.stringify({
      id: candidate.id,
      owner: candidate.owner,
      version: candidate.version,
      lifecycle: candidate.lifecycle,
      resolutionKind: candidate.resolutionKind,
      capability: candidate.resolutionCapability,
      contractVersion: candidate.contractVersion,
    }, null, 2)}`,
    ...(extra ? [`Additional user-approved implementation guidance:\n${extra}`] : []),
    'Finish with a concise summary of files changed and any remaining validation concerns.',
  ].join('\n\n')
}

function snapshot(root: string): Snapshot {
  const files = new Map<string, Buffer>()
  let entries = 0
  let bytes = 0
  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > WORKBENCH_MAX_LIST_DEPTH) throw new DevelopmentExecutorContractError('candidate workspace exceeds the maximum directory depth')
    for (const entry of readdirSync(dir)) {
      entries += 1
      if (entries > WORKBENCH_MAX_TRAVERSAL_ENTRIES) throw new DevelopmentExecutorContractError('candidate workspace traversal limit exceeded')
      const relative = prefix ? `${prefix}/${entry}` : entry
      const absolute = path.join(dir, entry)
      const stat = lstatSync(absolute)
      if (stat.isSymbolicLink()) throw new DevelopmentExecutorContractError(`development executor created a forbidden symlink: ${relative}`)
      if (stat.isDirectory()) {
        walk(absolute, relative, depth + 1)
        continue
      }
      if (!stat.isFile()) throw new DevelopmentExecutorContractError(`development executor created an unsupported filesystem entry: ${relative}`)
      if (stat.size > WORKBENCH_MAX_FILE_BYTES) throw new DevelopmentExecutorContractError(`candidate file exceeds size limit: ${relative}`)
      bytes += stat.size
      if (bytes > WORKBENCH_MAX_WORKSPACE_BYTES) throw new DevelopmentExecutorContractError('candidate workspace exceeds size limit')
      files.set(relative.replaceAll('\\', '/'), readFileSync(absolute))
      if (files.size > WORKBENCH_MAX_FILE_COUNT) throw new DevelopmentExecutorContractError('candidate workspace contains too many files')
    }
  }
  walk(root, '', 0)
  return files
}

function restore(root: string, files: Snapshot): void {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  for (const [relative, content] of files) {
    const target = path.join(root, ...relative.split('/'))
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
}

function changed(before: Snapshot, after: Snapshot): string[] {
  const names = new Set([...before.keys(), ...after.keys()])
  return [...names].filter((name) => {
    const left = before.get(name)
    const right = after.get(name)
    return !left || !right || createHash('sha256').update(left).digest('hex') !== createHash('sha256').update(right).digest('hex')
  }).sort()
}

function resultFromRun(run: DevelopmentRun): DevelopmentRunResult {
  return {
    runId: run.runId,
    candidateId: run.candidateId,
    executor: run.executor,
    status: run.status as DevelopmentRunResult['status'],
    changedFiles: run.changedFiles,
    durationMs: run.durationMs ?? 0,
    output: run.output ?? '',
    outputTruncated: run.outputTruncated,
    rolledBack: run.rolledBack,
    next: run.status === 'completed'
      ? 'Inspect the changed files, update the manifest through TARS-NG if needed, then run deterministic candidate validation.'
      : 'No candidate changes were retained. Review the executor output before retrying or use TARS-NG Native.',
  }
}
