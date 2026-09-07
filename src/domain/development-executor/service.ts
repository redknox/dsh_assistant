import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { CandidateWorkspace } from '../candidate/index.js'
import {
  WORKBENCH_MAX_FILE_BYTES,
  WORKBENCH_MAX_FILE_COUNT,
  WORKBENCH_MAX_LIST_DEPTH,
  WORKBENCH_MAX_TRAVERSAL_ENTRIES,
  WORKBENCH_MAX_WORKSPACE_BYTES,
  type CandidateWorkbench,
} from '../workbench/index.js'
import type {
  DevelopmentExecutor,
  DevelopmentExecutorAvailability,
  DevelopmentExecutorHub,
  DevelopmentRunResult,
  ExternalDevelopmentExecutorId,
} from './types.js'

type Snapshot = ReadonlyMap<string, Buffer>

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
  private readonly active = new Set<string>()
  private availabilityCache?: { readonly at: number; readonly value: readonly DevelopmentExecutorAvailability[] }

  constructor(
    private readonly workspace: CandidateWorkspace,
    private readonly workbench: CandidateWorkbench,
    executors: readonly DevelopmentExecutor[],
  ) {
    for (const executor of executors) this.executors.set(executor.id, executor)
  }

  inspect(): readonly DevelopmentExecutorAvailability[] {
    if (this.availabilityCache && Date.now() - this.availabilityCache.at < 30_000) return this.availabilityCache.value
    const value: readonly DevelopmentExecutorAvailability[] = [
      {
        id: 'native',
        label: 'TARS-NG Native',
        available: true,
        native: true,
        detail: 'Built-in candidate authoring tools; default and fallback path.',
      },
      ...[...this.executors.values()].map((executor) => executor.inspect()),
    ]
    this.availabilityCache = { at: Date.now(), value }
    return value
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
    if (this.active.has(input.candidateId)) throw new DevelopmentExecutorContractError('candidate already has an active development executor')

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
    this.active.add(candidate.id)
    try {
      const execution = await executor.execute({
        candidateId: candidate.id,
        workspaceRoot: candidate.workspaceRoot,
        prompt: taskPrompt(view, this.workbench.inspectAuthoringContract(view.contractVersion), input.instructions),
        signal: input.signal,
      })
      if (execution.exitCode !== 0) {
        restore(candidate.workspaceRoot, before)
        return result(runId, candidate.id, input.executor, input.signal?.aborted ? 'cancelled' : 'failed', [], execution, true)
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
      return result(runId, candidate.id, input.executor, 'completed', changedFiles, execution, false)
    } catch (error) {
      restore(candidate.workspaceRoot, before)
      if (error instanceof DevelopmentExecutorContractError) throw error
      throw new DevelopmentExecutorContractError(error instanceof Error ? error.message : 'development executor failed')
    } finally {
      this.active.delete(candidate.id)
    }
  }
}

function isHostOwnedArtifact(relativePath: string): boolean {
  return relativePath === 'candidate.manifest.json'
    || relativePath === 'capability-specification.json'
    || relativePath === 'generated-extension-api.json'
    || relativePath === '.dsh'
    || relativePath.startsWith('.dsh/')
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

function result(
  runId: string,
  candidateId: string,
  executor: ExternalDevelopmentExecutorId,
  status: DevelopmentRunResult['status'],
  changedFiles: readonly string[],
  execution: { exitCode: number | null; output: string; truncated: boolean; durationMs: number },
  rolledBack: boolean,
): DevelopmentRunResult {
  return {
    runId,
    candidateId,
    executor,
    status,
    changedFiles,
    durationMs: execution.durationMs,
    output: execution.output,
    outputTruncated: execution.truncated,
    rolledBack,
    next: status === 'completed'
      ? 'Inspect the changed files, update the manifest through TARS-NG if needed, then run deterministic candidate validation.'
      : 'No candidate changes were retained. Review the executor output before retrying or use TARS-NG Native.',
  }
}
