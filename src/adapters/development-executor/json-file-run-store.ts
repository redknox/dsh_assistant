import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  WORKBENCH_MAX_FILE_BYTES,
  WORKBENCH_MAX_FILE_COUNT,
  WORKBENCH_MAX_LIST_DEPTH,
  WORKBENCH_MAX_TRAVERSAL_ENTRIES,
  WORKBENCH_MAX_WORKSPACE_BYTES,
} from '../../domain/workbench/index.js'
import type { DevelopmentRun, DevelopmentRunStore } from '../../domain/development-executor/index.js'

interface RunFile { readonly version: 1; readonly runs: readonly DevelopmentRun[] }
interface SnapshotFile { readonly version: 1; readonly files: Readonly<Record<string, string>> }

const ACTIVE = new Set(['preparing', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'timed-out', 'interrupted'])
const EXECUTORS = new Set(['codex', 'claude-code'])
const MAX_RUNS = 200
const MAX_RUN_OUTPUT_BYTES = 256 * 1024
const MAX_RUN_STORE_BYTES = 64 * 1024 * 1024

/** Owner-only, atomic local adapter for durable Development Run metadata and rollback snapshots. */
export class JsonFileDevelopmentRunStore implements DevelopmentRunStore {
  private readonly runsFile: string
  private readonly snapshots: string

  constructor(private readonly root: string) {
    this.runsFile = path.join(root, 'runs.json')
    this.snapshots = path.join(root, 'snapshots')
  }

  list(): readonly DevelopmentRun[] {
    if (!existsSync(this.runsFile)) return []
    if (statSync(this.runsFile).size > MAX_RUN_STORE_BYTES) throw new Error('Development Run store exceeds size limit')
    const parsed = JSON.parse(readFileSync(this.runsFile, 'utf8')) as { version?: unknown; runs?: unknown }
    if (parsed.version !== 1 || !Array.isArray(parsed.runs)) throw new Error('invalid Development Run store')
    return parsed.runs.map(decodeRun)
  }

  save(run: DevelopmentRun): void {
    const rows = this.list().filter((item) => item.runId !== run.runId)
    rows.push(decodeRun(run))
    rows.sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    this.writeRuns(rows.slice(0, MAX_RUNS))
  }

  stageSnapshot(runId: string, workspaceRoot: string): void {
    const files: Record<string, string> = {}
    let entries = 0
    let bytes = 0
    const walk = (dir: string, prefix: string, depth: number) => {
      if (depth > WORKBENCH_MAX_LIST_DEPTH) throw new Error('candidate workspace exceeds snapshot depth')
      for (const entry of readdirSync(dir)) {
        entries += 1
        if (entries > WORKBENCH_MAX_TRAVERSAL_ENTRIES) throw new Error('candidate workspace exceeds snapshot traversal limit')
        const relative = prefix ? `${prefix}/${entry}` : entry
        const absolute = path.join(dir, entry)
        const stat = lstatSync(absolute)
        if (stat.isSymbolicLink()) throw new Error(`candidate snapshot rejects symlink: ${relative}`)
        if (stat.isDirectory()) {
          walk(absolute, relative, depth + 1)
          continue
        }
        if (!stat.isFile() || stat.size > WORKBENCH_MAX_FILE_BYTES) throw new Error(`candidate snapshot rejects entry: ${relative}`)
        bytes += stat.size
        if (bytes > WORKBENCH_MAX_WORKSPACE_BYTES) throw new Error('candidate workspace exceeds snapshot size')
        files[relative] = readFileSync(absolute).toString('base64')
        if (Object.keys(files).length > WORKBENCH_MAX_FILE_COUNT) throw new Error('candidate workspace exceeds snapshot file count')
      }
    }
    walk(workspaceRoot, '', 0)
    this.writeAtomic(this.snapshotFile(runId), { version: 1, files } satisfies SnapshotFile)
  }

  restoreSnapshot(runId: string, workspaceRoot: string): void {
    const parsed = JSON.parse(readFileSync(this.snapshotFile(runId), 'utf8')) as { version?: unknown; files?: unknown }
    if (parsed.version !== 1 || typeof parsed.files !== 'object' || parsed.files === null || Array.isArray(parsed.files)) {
      throw new Error('invalid Development Run snapshot')
    }
    const files = parsed.files as Record<string, unknown>
    const decoded: Array<{ readonly relative: string; readonly contents: Buffer }> = []
    let bytes = 0
    if (Object.keys(files).length > WORKBENCH_MAX_FILE_COUNT) throw new Error('Development Run snapshot exceeds file count')
    for (const [relative, encoded] of Object.entries(files)) {
      if (!safeRelative(relative) || typeof encoded !== 'string') throw new Error('invalid Development Run snapshot entry')
      const contents = Buffer.from(encoded, 'base64')
      if (contents.toString('base64') !== encoded || contents.length > WORKBENCH_MAX_FILE_BYTES) {
        throw new Error('invalid Development Run snapshot contents')
      }
      bytes += contents.length
      if (bytes > WORKBENCH_MAX_WORKSPACE_BYTES) throw new Error('Development Run snapshot exceeds workspace size')
      decoded.push({ relative, contents })
    }
    rmSync(workspaceRoot, { recursive: true, force: true })
    mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 })
    for (const { relative, contents } of decoded) {
      const target = path.join(workspaceRoot, ...relative.split('/'))
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
      writeFileSync(target, contents, { mode: 0o600 })
    }
  }

  discardSnapshot(runId: string): void {
    try { unlinkSync(this.snapshotFile(runId)) } catch (error) {
      if (!isMissing(error)) throw error
    }
  }

  private snapshotFile(runId: string): string {
    if (!/^dev-[0-9a-f-]{36}$/.test(runId)) throw new Error('invalid Development Run id')
    return path.join(this.snapshots, `${runId}.json`)
  }

  private writeRuns(runs: readonly DevelopmentRun[]): void {
    this.writeAtomic(this.runsFile, { version: 1, runs } satisfies RunFile)
  }

  private writeAtomic(file: string, value: unknown): void {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, file)
  }
}

function decodeRun(value: unknown): DevelopmentRun {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid Development Run record')
  const row = value as Record<string, unknown>
  if (typeof row.runId !== 'string' || !/^dev-[0-9a-f-]{36}$/.test(row.runId)) throw new Error('invalid Development Run id')
  if (typeof row.candidateId !== 'string' || !EXECUTORS.has(String(row.executor)) || !ACTIVE.has(String(row.status))) throw new Error('invalid Development Run identity')
  if (typeof row.startedAt !== 'string' || typeof row.updatedAt !== 'string' || !Number.isSafeInteger(row.progressBytes)) throw new Error('invalid Development Run timing')
  if (!Number.isFinite(Date.parse(row.startedAt)) || !Number.isFinite(Date.parse(row.updatedAt))) throw new Error('invalid Development Run timestamp')
  if (row.pid !== undefined && (!Number.isSafeInteger(row.pid) || Number(row.pid) <= 0)) throw new Error('invalid Development Run pid')
  if (!Array.isArray(row.changedFiles) || row.changedFiles.some((item) => typeof item !== 'string' || !safeRelative(item))) throw new Error('invalid Development Run changes')
  if (row.output !== undefined && (typeof row.output !== 'string' || Buffer.byteLength(row.output, 'utf8') > MAX_RUN_OUTPUT_BYTES)) throw new Error('invalid Development Run output')
  if (typeof row.outputTruncated !== 'boolean' || typeof row.rolledBack !== 'boolean' || typeof row.detail !== 'string') throw new Error('invalid Development Run result')
  return structuredClone(row) as unknown as DevelopmentRun
}

function safeRelative(value: string): boolean {
  return value !== '' && !path.isAbsolute(value) && !value.split('/').some((part) => part === '' || part === '.' || part === '..')
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}
