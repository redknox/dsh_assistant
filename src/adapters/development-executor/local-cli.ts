import { spawn, spawnSync } from 'node:child_process'
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
}

abstract class LocalCliDevelopmentExecutor implements DevelopmentExecutor {
  abstract readonly id: ExternalDevelopmentExecutorId
  abstract readonly label: string
  protected abstract argv(task: DevelopmentTask): readonly string[]

  constructor(private readonly options: LocalCliExecutorOptions = {}) {}

  protected abstract defaultExecutable(): string

  inspect(): DevelopmentExecutorAvailability {
    const executable = this.options.executable ?? this.defaultExecutable()
    const inspected = spawnSync(executable, ['--version'], {
      encoding: 'utf8',
      timeout: 3_000,
      env: executorEnvironment(this.options.env),
    })
    const detail = `${inspected.stdout ?? ''}${inspected.stderr ?? ''}`.trim().split('\n')[0]
    return {
      id: this.id,
      label: this.label,
      available: inspected.status === 0,
      native: false,
      detail: inspected.status === 0 ? detail || `${this.label} is installed` : `${this.label} CLI is not installed or not authenticated`,
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
        signal: task.signal,
      })
      const chunks: Buffer[] = []
      let bytes = 0
      let truncated = false
      let settled = false
      const capture = (chunk: Buffer) => {
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
      child.stdin.end(task.prompt)

      const timeout = setTimeout(() => child.kill('SIGTERM'), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      const finish = (exitCode: number | null) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve({
          exitCode,
          output: Buffer.concat(chunks).toString('utf8'),
          truncated,
          durationMs: Date.now() - started,
        })
      }
      child.once('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (task.signal?.aborted && error.name === 'AbortError') {
          resolve({
            exitCode: null,
            output: Buffer.concat(chunks).toString('utf8'),
            truncated,
            durationMs: Date.now() - started,
          })
          return
        }
        reject(error)
      })
      child.once('close', finish)
    })
  }
}

export class CodexDevelopmentExecutor extends LocalCliDevelopmentExecutor {
  readonly id = 'codex' as const
  readonly label = 'Codex'
  protected defaultExecutable() { return 'codex' }
  protected argv(task: DevelopmentTask): readonly string[] {
    return [
      'exec',
      '--json',
      '--color', 'never',
      '--sandbox', 'workspace-write',
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
  protected argv(_task: DevelopmentTask): readonly string[] {
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
    ]
  }
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
