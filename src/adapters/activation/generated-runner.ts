import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectOsNetworkSandbox } from '../../domain/candidate/os-sandbox.js'
import { listSourceFiles } from '../../domain/candidate/files.js'
import { digestFiles } from '../../domain/candidate/digest.js'
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
  readonly tools: string[] = []

  constructor(private readonly input: GeneratedPrepareInput) {}

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
      const artifact = existsSync(this.input.workspaceRoot) ? realpathSync(this.input.workspaceRoot) : path.resolve(this.input.workspaceRoot)
      if (this.input.digest !== undefined && this.input.digest !== '') {
        const digest = digestFiles(artifact, listSourceFiles(artifact))
        if (digest !== this.input.digest) {
          const diagnostics = 'generated artifact digest does not match the approved sealed digest'
          recordGeneratedRuntimeFailure(diagnostics)
          return { ok: false, diagnostics }
        }
      }
      const entry = resolveCandidateEntry(artifact, this.input.entryPoints)
      const relativeEntry = path.relative(artifact, entry)
      const childMain = resolveChildMain()
      const nodePrefix = path.dirname(path.dirname(process.execPath))
      const nodeArgv = [
        process.execPath,
        ...(childMain.endsWith('.ts') ? ['--experimental-strip-types'] : []),
        '--permission',
        `--allow-fs-read=${withSep(artifact)}`,
        `--allow-fs-read=${childMain}`,
        `--allow-fs-read=${withSep(path.dirname(childMain))}`,
        `--allow-fs-read=${withSep(path.dirname(process.execPath))}`,
        `--allow-fs-read=${withSep(nodePrefix)}`,
        '--no-addons',
        childMain,
      ]
      const wrapped = wrapGeneratedOsSandbox(sandbox, nodeArgv, artifact, process.execPath)
      const child = spawn(wrapped.file, wrapped.args, {
        cwd: artifact,
        env: {
          PATH: '/usr/bin:/bin',
          TZ: 'UTC',
          LANG: 'C',
          NODE_ENV: 'generated-runtime',
          DSH_GENERATED_ARTIFACT: artifact,
          DSH_GENERATED_ENTRY: relativeEntry,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.child = child
      recordGeneratedProcessStart()
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        this.stderr = `${this.stderr}${chunk}`.slice(-GENERATED_MAX_STDERR_BYTES)
      })
      const ready = this.waitForReady()
      const lines = createInterface({ input: child.stdout })
      lines.on('line', (line) => {
        void this.onLine(line)
      })
      child.on('exit', (code) => {
        this.failAll(`generated process exited (${code ?? 'null'}): ${this.stderr || 'no-stderr'}`)
        this.started = false
        recordGeneratedProcessStop()
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
    const names = Array.isArray(reply.tools) ? reply.tools.map((item) => String(item)) : []
    this.tools.splice(0, this.tools.length, ...names)
    return names
  }

  async call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const reply = await this.request({ op: 'call', tool, args }, GENERATED_CALL_TIMEOUT_MS, signal)
    if (reply.ok !== true) throw new Error(String(reply.error ?? 'generated tool failed'))
    return reply.value
  }

  kill(): void {
    if (this.child === undefined) return
    this.failAll('generated process terminated')
    this.child.kill('SIGKILL')
    this.child = undefined
    this.started = false
  }

  private waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('generated runner startup timed out'))
      }, GENERATED_STARTUP_TIMEOUT_MS)
      this.pending.set('ready', {
        resolve: (message) => {
          clearTimeout(timer)
          if (Array.isArray(message.tools)) this.tools.splice(0, this.tools.length, ...message.tools.map((item) => String(item)))
          resolve()
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
    })
  }

  private async onLine(line: string): Promise<void> {
    if (Buffer.byteLength(line) > GENERATED_MAX_MESSAGE_BYTES) {
      this.kill()
      recordGeneratedRuntimeFailure('generated protocol message exceeded the size bound')
      return
    }
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      this.kill()
      recordGeneratedRuntimeFailure('generated protocol violation: invalid JSON')
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
      }, timeoutMs)
      const onAbort = () => {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error('generated call was cancelled'))
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
      this.kill()
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

export function resolveChildMain(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const js = path.join(here, 'generated-child-main.js')
  if (existsSync(js)) return js
  const ts = path.join(here, 'generated-child-main.ts')
  if (existsSync(ts)) return ts
  throw new Error('generated child runner is missing')
}

