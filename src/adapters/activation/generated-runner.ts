import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectOsNetworkSandbox } from '../../domain/candidate/os-sandbox.js'
import { listSourceFiles } from '../../domain/candidate/files.js'
import { contractDigestExtras, digestFiles } from '../../domain/candidate/digest.js'
import { GENERATED_EXTENSION_API_V1 } from '../../domain/workbench/authoring-contract.js'
import {
  approvedHostCapabilities,
  executeHostBroker,
  generatedIsolation,
  GENERATED_CALL_TIMEOUT_MS,
  GENERATED_MAX_MESSAGE_BYTES,
  GENERATED_MAX_STDERR_BYTES,
  GENERATED_STARTUP_TIMEOUT_MS,
  recordGeneratedProcessStart,
  recordGeneratedProcessStop,
  recordGeneratedRuntimeFailure,
  sanitizeGeneratedDiagnostic,
  type GeneratedPrepareInput,
  type GeneratedToolDescriptor,
} from '../../domain/generated-runtime/index.js'
import { resolveCandidateEntry } from './candidate-entry.js'
import { wrapGeneratedOsSandbox } from './generated-os-sandbox.js'

interface Pending {
  readonly resolve: (value: Record<string, unknown>) => void
  readonly reject: (error: Error) => void
}

export class IsolatedGeneratedRunner {
  private child?: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, Pending>()
  private nextId = 1
  private stderr = ''
  private started = false
  private exited = Promise.resolve()
  private resolveExit?: () => void
  private fatal = false
  private stdoutBuffer = ''
  private pgid?: number
  runId = ''
  onFatal?: (reason: string) => void | Promise<void>
  private fatalSettled = Promise.resolve()
  private resolveFatal?: () => void
  readonly tools: string[] = []
  descriptors: GeneratedToolDescriptor[] = []

  constructor(private readonly input: GeneratedPrepareInput) {}

  get owner(): string {
    return this.input.owner
  }

  get candidateId(): string {
    return this.input.candidateId
  }

  async start(): Promise<{ ok: boolean; diagnostics?: string }> {
    if (generatedIsolation() === 'unavailable') {
      const diagnostics = 'generated-runtime isolation is unavailable; generated activation refused (no host fallback)'
      recordGeneratedRuntimeFailure(diagnostics)
      return { ok: false, diagnostics }
    }
    const sandbox = detectOsNetworkSandbox()
    if (sandbox === undefined) {
      const diagnostics = 'generated-runtime isolation is unavailable; generated activation refused (no host fallback)'
      recordGeneratedRuntimeFailure(diagnostics)
      return { ok: false, diagnostics }
    }
    try {
      if (
        (this.input.owner.startsWith('generated/') || this.input.owner.startsWith('third-party/'))
        && this.input.runtimeContractVersion !== GENERATED_EXTENSION_API_V1
      ) {
        const diagnostics = this.input.runtimeContractVersion === undefined
          ? 'generated activation refused: missing host-owned authoring contract'
          : `generated activation refused: unsupported authoring contract ${this.input.runtimeContractVersion}`
        recordGeneratedRuntimeFailure(diagnostics)
        return { ok: false, diagnostics }
      }
      const artifact = existsSync(this.input.workspaceRoot) ? realpathSync(this.input.workspaceRoot) : path.resolve(this.input.workspaceRoot)
      if (this.input.digest !== undefined && this.input.digest !== '') {
        const digest = digestFiles(
          artifact,
          listSourceFiles(artifact),
          contractDigestExtras(this.input.runtimeContractVersion),
        )
        if (digest !== this.input.digest) {
          const diagnostics = 'generated artifact digest does not match the approved sealed digest'
          recordGeneratedRuntimeFailure(diagnostics)
          return { ok: false, diagnostics }
        }
      }
      const entry = resolveCandidateEntry(artifact, this.input.entryPoints)
      const relativeEntry = path.relative(artifact, entry)
      const childMain = stageChildMain()
      const nodeArgv = [
        process.execPath,
        ...(childMain.file.endsWith('.ts') ? ['--experimental-strip-types'] : []),
        '--permission',
        `--allow-fs-read=${withSep(artifact)}`,
        `--allow-fs-read=${withSep(childMain.dir)}`,
        '--no-addons',
        childMain.file,
      ]
      const wrapped = wrapGeneratedOsSandbox(sandbox, nodeArgv, artifact, process.execPath)
      this.runId = `tars-ng-gen-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
      const child = spawn(wrapped.file, wrapped.args, {
        cwd: artifact,
        env: {
          PATH: '/usr/bin:/bin',
          TZ: 'UTC',
          LANG: 'C',
          NODE_ENV: 'generated-runtime',
          DSH_GENERATED_ARTIFACT: artifact,
          DSH_GENERATED_ENTRY: relativeEntry,
          DSH_GENERATED_RUN_ID: this.runId,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      })
      this.child = child
      this.pgid = child.pid
      this.exited = new Promise((resolve) => {
        this.resolveExit = resolve
      })
      recordGeneratedProcessStart()
      this.fatalSettled = new Promise((resolve) => {
        this.resolveFatal = resolve
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        this.stderr = `${this.stderr}${chunk}`.slice(-GENERATED_MAX_STDERR_BYTES)
      })
      const ready = this.waitForReady()
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        this.onStdoutChunk(chunk)
      })
      child.on('exit', (code) => {
        const reason = sanitizeGeneratedDiagnostic(`generated process exited (${code ?? 'null'}): ${this.stderr || 'no-stderr'}`)
        this.failAll(reason)
        this.started = false
        this.child = undefined
        recordGeneratedProcessStop()
        this.resolveExit?.()
        void Promise.resolve(this.onFatal?.(reason)).finally(() => this.resolveFatal?.())
      })
      await ready
      this.started = true
      return { ok: true }
    } catch (error) {
      this.kill()
      const diagnostics = sanitizeGeneratedDiagnostic(error instanceof Error ? error.message : String(error))
      recordGeneratedRuntimeFailure(diagnostics)
      return { ok: false, diagnostics }
    }
  }

  async health(): Promise<readonly string[]> {
    const reply = await this.request({ op: 'health' }, GENERATED_CALL_TIMEOUT_MS)
    this.ingestDescriptors(reply)
    return this.tools
  }

  async call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    try {
      const reply = await this.request({ op: 'call', tool, args }, GENERATED_CALL_TIMEOUT_MS, signal)
      if (reply.ok !== true) throw new Error(String(reply.error ?? 'generated tool failed'))
      return reply.value
    } catch (error) {
      if (this.fatal) await this.waitForExit()
      throw error
    }
  }

  kill(): void {
    const pid = this.child?.pid ?? this.pgid
    if (pid === undefined) {
      this.resolveExit?.()
      return
    }
    this.failAll('generated process terminated')
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      this.child?.kill('SIGKILL')
    }
  }

  async shutdown(): Promise<void> {
    if (this.child === undefined) return
    try {
      const reply = await this.request({ op: 'shutdown' }, GENERATED_CALL_TIMEOUT_MS)
      if (reply.ok !== true) throw new Error(String(reply.error ?? 'generated cleanup failed'))
      await this.waitForExit(1_000)
      if (this.child !== undefined) this.kill()
    } catch (error) {
      this.kill()
      throw error
    }
  }

  async waitForExit(timeoutMs = 10_000): Promise<void> {
    await Promise.race([
      Promise.all([this.exited, this.fatalSettled]),
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs)
      }),
    ])
  }

  failClosed(reason: string): void {
    const diagnostics = sanitizeGeneratedDiagnostic(reason)
    recordGeneratedRuntimeFailure(diagnostics)
    this.fatal = true
    this.failAll(diagnostics)
    this.kill()
  }

  private waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('generated runner startup timed out'))
      }, GENERATED_STARTUP_TIMEOUT_MS)
      this.pending.set('ready', {
        resolve: (message) => {
          clearTimeout(timer)
          this.ingestDescriptors(message)
          resolve()
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
    })
  }

  private ingestDescriptors(message: Record<string, unknown>): void {
    const raw = Array.isArray(message.descriptors) ? message.descriptors : []
    const parsed: GeneratedToolDescriptor[] = raw.flatMap((item) => {
      if (item === null || typeof item !== 'object') return []
      const row = item as Record<string, unknown>
      const name = String(row.name ?? '')
      if (name === '' || name === '*') return []
      return [{
        name,
        description: String(row.description ?? `Isolated generated proxy for ${name}`),
        parameters: (row.parameters && typeof row.parameters === 'object' && !Array.isArray(row.parameters))
          ? row.parameters as Record<string, unknown>
          : {},
        output: (row.output && typeof row.output === 'object' && !Array.isArray(row.output))
          ? row.output as Record<string, unknown>
          : { type: 'string' },
      }]
    })
    this.descriptors = parsed
    this.tools.splice(0, this.tools.length, ...parsed.map((item) => item.name))
  }

  private onStdoutChunk(chunk: string): void {
    if (this.fatal) return
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf('\n', offset)
      if (newline === -1) {
        const rest = chunk.slice(offset)
        if (Buffer.byteLength(this.stdoutBuffer) + Buffer.byteLength(rest) > GENERATED_MAX_MESSAGE_BYTES) {
          this.failClosed('generated protocol message exceeded the size bound')
          return
        }
        this.stdoutBuffer += rest
        return
      }
      const line = `${this.stdoutBuffer}${chunk.slice(offset, newline)}`
      this.stdoutBuffer = ''
      offset = newline + 1
      if (Buffer.byteLength(line) > GENERATED_MAX_MESSAGE_BYTES) {
        this.failClosed('generated protocol message exceeded the size bound')
        return
      }
      void this.onLine(line)
    }
  }

  private async onLine(line: string): Promise<void> {
    if (Buffer.byteLength(line) > GENERATED_MAX_MESSAGE_BYTES) {
      this.failClosed('generated protocol message exceeded the size bound')
      return
    }
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      this.failClosed('generated protocol violation: invalid JSON')
      return
    }
    if (message.op === 'ready') {
      this.pending.get('ready')?.resolve(message)
      this.pending.delete('ready')
      return
    }
    if (message.op === 'broker-request') {
      const id = String(message.id ?? '')
      try {
        const value = executeHostBroker({
          capability: String(message.capability ?? ''),
          args: (message.args && typeof message.args === 'object') ? message.args as Record<string, unknown> : {},
        }, approvedHostCapabilities(this.input.permissions))
        this.write({ id, op: 'broker-result', ok: true, value })
      } catch (error) {
        this.write({
          id,
          op: 'broker-result',
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }
    const id = String(message.id ?? '')
    const waiter = this.pending.get(id)
    if (waiter === undefined) return
    this.pending.delete(id)
    waiter.resolve(message)
  }

  private request(body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (this.child === undefined) return Promise.reject(new Error('generated process is not running'))
    const id = String(this.nextId++)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('generated call timed out'))
        this.failClosed('generated call timed out')
      }, timeoutMs)
      const onAbort = () => {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error('generated call was cancelled'))
        this.failClosed('generated call was cancelled')
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      })
      this.write({ id, ...body })
    })
  }

  private write(message: Record<string, unknown>): void {
    const line = `${JSON.stringify(message)}\n`
    if (Buffer.byteLength(line) > GENERATED_MAX_MESSAGE_BYTES) {
      this.failClosed('generated protocol message exceeded the size bound')
      throw new Error('generated protocol message exceeded the size bound')
    }
    this.child?.stdin.write(line)
  }

  private failAll(reason: string): void {
    const error = new Error(sanitizeGeneratedDiagnostic(reason))
    for (const waiter of this.pending.values()) waiter.reject(error)
    this.pending.clear()
  }
}

function withSep(dir: string): string {
  return dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`
}

function stageChildMain(): { file: string; dir: string } {
  const source = resolveChildMain()
  const dir = mkdtempSync(path.join(tmpdir(), 'tars-ng-gen-shim-'))
  const dest = path.join(dir, path.basename(source))
  copyFileSync(source, dest)
  const file = realpathSync(dest)
  return { file, dir: path.dirname(file) }
}

/** OS-visible generated children, including descendants of an unshare wrapper. */
export function listGeneratedRuntimePids(match: { readonly runId?: string; readonly artifact?: string } = {}): number[] {
  const token = match.runId === undefined ? undefined : `DSH_GENERATED_RUN_ID=${match.runId}`
  const artifact = match.artifact === undefined ? undefined : `DSH_GENERATED_ARTIFACT=${match.artifact}`
  const hits: number[] = []
  if (process.platform === 'linux') {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      try {
        const env = readFileSync(`/proc/${entry}/environ`, 'utf8')
        if (token !== undefined && env.includes(token)) hits.push(Number(entry))
        else if (token === undefined && artifact !== undefined && env.includes(artifact)) hits.push(Number(entry))
        else if (token === undefined && artifact === undefined && env.includes('NODE_ENV=generated-runtime')) hits.push(Number(entry))
      } catch {
        /* process exited or environ is unreadable */
      }
    }
    return hits
  }
  try {
    const text = execFileSync('ps', ['eww', '-A'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    for (const line of text.split('\n')) {
      if (token !== undefined && !line.includes(token)) continue
      else if (token === undefined && artifact !== undefined && !line.includes(artifact)) continue
      else if (token === undefined && artifact === undefined && !line.includes('NODE_ENV=generated-runtime')) continue
      const pid = Number(line.trim().split(/\s+/)[0])
      if (Number.isInteger(pid) && pid > 0) hits.push(pid)
    }
  } catch {
    return []
  }
  return hits
}

export function resolveChildMain(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const js = path.join(here, 'generated-child-main.js')
  if (existsSync(js)) return js
  const ts = path.join(here, 'generated-child-main.ts')
  if (existsSync(ts)) return ts
  throw new Error('generated child runner is missing')
}
