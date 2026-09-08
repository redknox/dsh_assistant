import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type {
  DevelopmentExecution,
  DevelopmentExecutor,
  DevelopmentExecutorAvailability,
  DevelopmentTask,
  ExternalDevelopmentExecutorId,
} from '../../domain/development-executor/index.js'

const MAX_OUTPUT_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 15 * 60_000

export interface LocalCliExecutorOptions {
  readonly executable?: string
  readonly timeoutMs?: number
  readonly env?: NodeJS.ProcessEnv
  readonly settingsFile?: string
}

abstract class LocalCliDevelopmentExecutor implements DevelopmentExecutor {
  abstract readonly id: ExternalDevelopmentExecutorId
  abstract readonly label: string
  protected abstract argv(task: DevelopmentTask): readonly string[]
  protected abstract authArgv(): readonly string[]
  protected abstract authSucceeded(result: { readonly status: number | null; readonly stdout: string; readonly stderr: string }): boolean

  constructor(protected readonly options: LocalCliExecutorOptions = {}) {}

  protected abstract defaultExecutable(): string

  inspect(): DevelopmentExecutorAvailability {
    const executable = this.options.executable ?? this.defaultExecutable()
    const inspected = spawnSync(executable, ['--version'], {
      encoding: 'utf8',
      timeout: 3_000,
      env: executorEnvironment(this.options.env),
    })
    const detail = `${inspected.stdout ?? ''}${inspected.stderr ?? ''}`.trim().split('\n').find((line) => !line.startsWith('WARNING:'))
    if (inspected.status !== 0) return {
      id: this.id,
      label: this.label,
      available: false,
      executionReady: false,
      native: false,
      authenticated: false,
      route: 'none',
      detail: `${this.label} CLI is not installed or its version probe failed`,
      verification: 'unavailable',
    }
    const auth = spawnSync(executable, this.authArgv(), {
      encoding: 'utf8',
      timeout: 3_000,
      env: executorEnvironment(this.options.env),
    })
    const authenticated = this.authSucceeded({ status: auth.status, stdout: auth.stdout ?? '', stderr: auth.stderr ?? '' })
    return {
      id: this.id,
      label: this.label,
      available: true,
      executionReady: authenticated,
      native: false,
      authenticated,
      route: 'provider-account',
      detail: detail || `${this.label} is installed`,
      verification: authenticated ? 'authenticated' : auth.error ? 'installed-unverified' : 'authentication-failed',
    }
  }

  execute(task: DevelopmentTask): Promise<DevelopmentExecution> {
    const started = Date.now()
    const executable = this.options.executable ?? this.defaultExecutable()
    return new Promise((resolve, reject) => {
      const child = spawn(executable, this.argv(task), {
        cwd: task.workspaceRoot,
        env: executorEnvironment(this.options.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })
      const chunks: Buffer[] = []
      let bytes = 0
      let truncated = false
      let settled = false
      let termination: DevelopmentExecution['termination'] = 'exited'
      let forceKill: ReturnType<typeof setTimeout> | undefined
      const capture = (chunk: Buffer) => {
        task.onProgress?.(chunk.length)
        if (bytes >= MAX_OUTPUT_BYTES) {
          truncated = true
          return
        }
        const remaining = MAX_OUTPUT_BYTES - bytes
        const accepted = chunk.subarray(0, remaining)
        chunks.push(accepted)
        bytes += accepted.length
        if (accepted.length < chunk.length) truncated = true
      }
      child.stdout.on('data', capture)
      child.stderr.on('data', capture)
      if (child.pid !== undefined) task.onSpawn?.(child.pid)
      child.stdin.end(task.prompt)

      const terminate = (reason: 'cancelled' | 'timed-out') => {
        if (settled || termination !== 'exited') return
        termination = reason
        killProcessTree(child.pid, 'SIGTERM')
        forceKill = setTimeout(() => killProcessTree(child.pid, 'SIGKILL'), 2_000)
        forceKill.unref?.()
      }
      const onAbort = () => terminate('cancelled')
      task.signal?.addEventListener('abort', onAbort, { once: true })
      if (task.signal?.aborted) onAbort()
      const timeout = setTimeout(() => terminate('timed-out'), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      const finish = (exitCode: number | null) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (forceKill) clearTimeout(forceKill)
        task.signal?.removeEventListener('abort', onAbort)
        resolve({
          exitCode,
          termination,
          output: Buffer.concat(chunks).toString('utf8'),
          truncated,
          durationMs: Date.now() - started,
        })
      }
      child.once('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (forceKill) clearTimeout(forceKill)
        task.signal?.removeEventListener('abort', onAbort)
        reject(error)
      })
      child.once('close', finish)
    })
  }

  terminateOrphan(run: { readonly pid?: number; readonly startedAt: string }): boolean {
    if (!run.pid) return true
    try { process.kill(run.pid, 0) } catch { return true }
    const inspected = spawnSync('ps', ['-p', String(run.pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8', timeout: 2_000 })
    if (inspected.status !== 0) return true
    const line = inspected.stdout.trim()
    const processStarted = Date.parse(line.slice(0, 24))
    const expectedStarted = Date.parse(run.startedAt)
    const executable = pathBasename(this.options.executable ?? this.defaultExecutable())
    if (!Number.isFinite(processStarted) || Math.abs(processStarted - expectedStarted) > 60_000 || !line.includes(executable)) return false
    // Recovery cannot await an old child lifecycle event. Once identity is
    // verified, use a terminal signal before restoring bytes into its workspace.
    killProcessTree(run.pid, 'SIGKILL')
    return true
  }
}

export class CodexDevelopmentExecutor extends LocalCliDevelopmentExecutor {
  readonly id = 'codex' as const
  readonly label = 'Codex'
  protected defaultExecutable() { return 'codex' }
  protected authArgv() { return ['login', 'status'] }
  protected authSucceeded(result: { readonly status: number | null; readonly stdout: string; readonly stderr: string }) {
    return result.status === 0 && /logged in/i.test(`${result.stdout}\n${result.stderr}`)
  }
  protected argv(task: DevelopmentTask): readonly string[] {
    return [
      'exec',
      '--json',
      '--color', 'never',
      '--approve-for-me',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-rules',
      '--cd', task.workspaceRoot,
      '-',
    ]
  }
}

export class ClaudeCodeDevelopmentExecutor extends LocalCliDevelopmentExecutor {
  readonly id = 'claude-code' as const
  readonly label = 'Claude Code'
  protected defaultExecutable() { return 'claude' }
  protected authArgv() { return ['auth', 'status'] }
  protected authSucceeded(result: { readonly status: number | null; readonly stdout: string; readonly stderr: string }) {
    if (result.status !== 0) return false
    try { return (JSON.parse(result.stdout) as { loggedIn?: unknown }).loggedIn === true } catch { return false }
  }
  override inspect(): DevelopmentExecutorAvailability {
    const inspected = super.inspect()
    const settings = this.customRouteSettings()
    if (!inspected.available || !settings) return inspected
    return {
      ...inspected,
      executionReady: true,
      authenticated: false,
      route: 'custom-provider',
      verification: 'custom-route-configured',
      detail: `${inspected.detail}; custom model route configured (execution verified on run).`,
    }
  }
  protected argv(_task: DevelopmentTask): readonly string[] {
    const settings = this.customRouteSettings()
    return [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--safe-mode',
      '--restricted',
      '--permission-mode', 'acceptEdits',
      '--permission-prompts', 'none',
      '--tools', 'Read,Write,Edit,Glob,Grep',
      ...(settings ? ['--settings', settings] : []),
    ]
  }

  private customRouteSettings(): string | undefined {
    const home = this.options.env?.HOME ?? process.env.HOME
    const file = this.options.settingsFile ?? (home ? path.join(home, '.claude', 'settings.json') : undefined)
    if (!file || !existsSync(file)) return undefined
    try {
      if (statSync(file).size > 64 * 1024) return undefined
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { model?: unknown; env?: unknown }
      if (typeof parsed.model !== 'string' || parsed.model === '' || !parsed.env || typeof parsed.env !== 'object' || Array.isArray(parsed.env)) return undefined
      const env = parsed.env as Record<string, unknown>
      if (typeof env.ANTHROPIC_BASE_URL !== 'string' || !/^https?:\/\//.test(env.ANTHROPIC_BASE_URL)) return undefined
      if (typeof env.ANTHROPIC_AUTH_TOKEN !== 'string' || env.ANTHROPIC_AUTH_TOKEN === '') return undefined
      return path.resolve(file)
    } catch {
      return undefined
    }
  }
}

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal)
  } catch {
    try { process.kill(pid, signal) } catch { /* already exited */ }
  }
}

function pathBasename(value: string): string {
  return value.replaceAll('\\', '/').split('/').at(-1) ?? value
}

function executorEnvironment(override?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const source = override ?? process.env
  const names = [
    'HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'USER', 'SHELL',
    'XDG_CONFIG_HOME', 'CODEX_HOME', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  ] as const
  const env: NodeJS.ProcessEnv = { NO_COLOR: '1', CI: '1' }
  for (const name of names) {
    const value = source[name]
    if (typeof value === 'string' && value !== '') env[name] = value
  }
  return env
}
