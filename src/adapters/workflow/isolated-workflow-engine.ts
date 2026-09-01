import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import WorkflowEngine, {
  WorkflowError,
  WorkflowRunId,
  type WorkflowAgentInfo,
  type WorkflowMeta,
  type WorkflowResult,
  type WorkflowRun,
  type WorkflowStartRequest,
} from '@deepseek-ai/dsh-workflow'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import { parse } from 'acorn'
import { detectOsNetworkSandbox } from '../../domain/candidate/os-sandbox.js'
import { wrapGeneratedOsSandbox } from '../activation/generated-os-sandbox.js'

const MAX_MESSAGE_BYTES = 256 * 1024
const MAX_STDERR_BYTES = 8 * 1024

export interface IsolatedWorkflowEngineConfig {
  readonly provider: string
  readonly maxConcurrentAgents: number
  readonly maxTotalAgents: number
  readonly maxItemsPerCall: number
  readonly disposeGraceMs: number
}

interface Observer {
  phase(title: string): void
  log(message: string): void
  agentStart(agent: WorkflowAgentInfo): void
  agentEnd(agent: WorkflowAgentInfo, outcome: 'completed' | 'failed' | 'cancelled'): void
}

function finalText(output: readonly ContentBlock[]): string {
  return output.filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text).join('')
}

function validateMeta(value: WorkflowMeta): WorkflowMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkflowError('invalid workflow meta', 'META_INVALID')
  const keys = Object.keys(value)
  if (keys.some((key) => !['name', 'description', 'whenToUse', 'phases'].includes(key))) {
    throw new WorkflowError('invalid workflow meta: unknown field', 'META_INVALID')
  }
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value.name) || typeof value.description !== 'string' || value.description.trim() === '') {
    throw new WorkflowError('invalid workflow meta: name and description are required', 'META_INVALID')
  }
  return JSON.parse(JSON.stringify(value)) as WorkflowMeta
}

function validateScript(script: string): void {
  try {
    parse(`async function __workflow(args, agent, parallel, pipeline, phase, log) {\n${script}\n}`, { ecmaVersion: 'latest' })
  } catch (error) {
    throw new WorkflowError(`workflow script does not parse: ${String(error)}`, 'SCRIPT_PARSE', { cause: error })
  }
}

class IsolatedRun implements WorkflowRun {
  readonly result: Promise<WorkflowResult>
  private resolveResult!: (value: WorkflowResult) => void
  private child?: ChildProcessWithoutNullStreams
  private stdout = ''
  private stderr = ''
  private settled = false
  private cancelled = false
  private readonly abort = new AbortController()
  private readonly children = new Map<string, { run: SubagentRun; info: WorkflowAgentInfo }>()
  private readonly pendingStarts = new Set<Promise<void>>()

  constructor(
    private readonly ctx: Context,
    readonly id: ReturnType<typeof WorkflowRunId>,
    readonly meta: WorkflowMeta,
    private readonly request: WorkflowStartRequest,
    private readonly provider: string,
    private readonly limits: Omit<IsolatedWorkflowEngineConfig, 'provider'>,
    private readonly observer: Observer,
  ) {
    this.result = new Promise((resolve) => { this.resolveResult = resolve })
    request.signal?.addEventListener('abort', () => this.cancel('caller aborted'), { once: true })
    void this.launch()
  }

  cancel(reason = 'cancelled'): void {
    if (this.settled || this.cancelled) return
    this.cancelled = true
    this.abort.abort(reason)
    this.write({ op: 'cancel' })
    void this.disposeChildren()
    setTimeout(() => {
      if (!this.settled) {
        this.kill()
        this.settle({ value: null, stopReason: 'cancelled', error: reason, agentsStarted: this.children.size })
      }
    }, this.limits.disposeGraceMs).unref()
  }

  async dispose(): Promise<void> {
    if (!this.settled) this.cancel('disposed')
    await Promise.race([this.result, new Promise<void>((resolve) => setTimeout(resolve, this.limits.disposeGraceMs))])
    await this.disposeChildren()
    this.kill()
  }

  private async launch(): Promise<void> {
    try {
      const sandbox = detectOsNetworkSandbox()
      if (!sandbox) throw new Error('isolated workflow runtime is unavailable')
      const staged = stageChildMain()
      const argv = [
        process.execPath,
        ...(staged.file.endsWith('.ts') ? ['--experimental-strip-types'] : []),
        '--permission', `--allow-fs-read=${staged.dir}${path.sep}`, '--no-addons', staged.file,
      ]
      const wrapped = wrapGeneratedOsSandbox(sandbox, argv, staged.dir, process.execPath)
      const child = spawn(wrapped.file, wrapped.args, {
        cwd: staged.dir,
        env: { PATH: '/usr/bin:/bin', TZ: 'UTC', LANG: 'C', NODE_ENV: 'governed-workflow' },
        stdio: ['pipe', 'pipe', 'pipe'], detached: true,
      })
      this.child = child
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => this.onChunk(chunk))
      child.stderr.on('data', (chunk: string) => { this.stderr = `${this.stderr}${chunk}`.slice(-MAX_STDERR_BYTES) })
      child.on('exit', (code) => {
        if (!this.settled) this.settle({
          value: null,
          stopReason: this.cancelled ? 'cancelled' : 'error',
          error: this.cancelled ? 'workflow run was cancelled' : `isolated workflow exited (${code ?? 'null'}): ${this.stderr || 'no detail'}`,
          agentsStarted: this.children.size,
        })
      })
    } catch (error) {
      this.settle({ value: null, stopReason: 'error', error: error instanceof Error ? error.message : String(error), agentsStarted: 0 })
    }
  }

  private onChunk(chunk: string): void {
    this.stdout += chunk
    if (Buffer.byteLength(this.stdout) > MAX_MESSAGE_BYTES) {
      this.cancel('workflow protocol exceeded the message limit')
      return
    }
    let newline = this.stdout.indexOf('\n')
    while (newline >= 0) {
      const line = this.stdout.slice(0, newline)
      this.stdout = this.stdout.slice(newline + 1)
      void this.onLine(line)
      newline = this.stdout.indexOf('\n')
    }
  }

  private async onLine(line: string): Promise<void> {
    let message: Record<string, unknown>
    try { message = JSON.parse(line) as Record<string, unknown> } catch { this.cancel('workflow protocol returned invalid JSON'); return }
    const op = String(message.op ?? '')
    if (op === 'ready') {
      this.write({
        op: 'start', script: this.request.script, args: this.request.args ?? null,
        maxTotalAgents: this.request.maxTotalAgents ?? this.limits.maxTotalAgents,
        maxItemsPerCall: this.limits.maxItemsPerCall,
        maxConcurrentAgents: this.limits.maxConcurrentAgents,
      })
    } else if (op === 'phase') this.observer.phase(String(message.title ?? ''))
    else if (op === 'log') this.observer.log(String(message.message ?? ''))
    else if (op === 'agent-request') {
      const task = this.startAgent(message)
      this.pendingStarts.add(task)
      void task.finally(() => this.pendingStarts.delete(task))
    } else if (op === 'result') {
      await Promise.allSettled(this.pendingStarts)
      await this.disposeChildren()
      this.settle({ value: message.value ?? null, stopReason: 'completed', agentsStarted: Number(message.agentsStarted ?? 0) })
    } else if (op === 'error') {
      await Promise.allSettled(this.pendingStarts)
      await this.disposeChildren()
      this.settle({ value: null, stopReason: this.cancelled ? 'cancelled' : 'error', error: String(message.error ?? 'workflow failed'), agentsStarted: Number(message.agentsStarted ?? 0) })
    }
  }

  private async startAgent(message: Record<string, unknown>): Promise<void> {
    const callId = String(message.id ?? '')
    if (this.cancelled || this.settled) return
    let run: SubagentRun | undefined
    try {
      run = await this.ctx.subagents.start(this.provider, {
        label: String(message.label ?? '').slice(0, 80),
        prompt: [{ type: 'text', text: String(message.prompt ?? '') }],
        parent: this.request.parent,
        signal: this.abort.signal,
        ...(message.schema && typeof message.schema === 'object' ? { outputSchema: message.schema as never } : {}),
        ...(typeof message.model === 'string' ? { agentOptions: { model: message.model } } : {}),
      })
      const info: WorkflowAgentInfo = {
        seq: Number(message.seq), label: String(message.label ?? ''),
        ...(typeof message.phase === 'string' ? { phase: message.phase } : {}), childId: run.id,
      }
      this.children.set(callId, { run, info })
      this.observer.agentStart(info)
      const result = await run.result
      const outcome = result.stopReason === 'completed' ? 'completed' : this.cancelled ? 'cancelled' : 'failed'
      this.observer.agentEnd(info, outcome)
      this.children.delete(callId)
      await run.dispose()
      if (result.stopReason !== 'completed') this.write({ op: 'agent-result', id: callId, value: null })
      else this.write({ op: 'agent-result', id: callId, value: result.structured ?? finalText(result.output) })
    } catch (error) {
      if (run) await run.dispose().catch(() => undefined)
      this.write({ op: 'agent-error', id: callId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  private async disposeChildren(): Promise<void> {
    const records = [...this.children.values()]
    this.children.clear()
    await Promise.allSettled(records.map(async ({ run, info }) => {
      await run.dispose()
      this.observer.agentEnd(info, 'cancelled')
    }))
  }

  private write(message: Record<string, unknown>): void {
    if (!this.child?.stdin.writable) return
    const line = `${JSON.stringify(message)}\n`
    if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) { this.cancel('workflow protocol message exceeded the limit'); return }
    this.child.stdin.write(line)
  }

  private settle(result: WorkflowResult): void {
    if (this.settled) return
    this.settled = true
    this.resolveResult(result)
    this.kill()
  }

  private kill(): void {
    const pid = this.child?.pid
    if (!pid) return
    try { process.kill(-pid, 'SIGKILL') } catch { this.child?.kill('SIGKILL') }
    this.child = undefined
  }
}

/** DSH WorkflowEngine adapter with a separate OS- and Node-permission-confined process per run. */
export class IsolatedWorkflowEngine extends WorkflowEngine {
  static inject = ['subagents']

  constructor(ctx: Context, private readonly config: IsolatedWorkflowEngineConfig) { super(ctx) }

  start(request: WorkflowStartRequest): WorkflowRun {
    const meta = validateMeta(request.meta)
    validateScript(request.script)
    const provider = request.subagentProvider ?? this.config.provider
    if (provider.trim() !== provider || provider === '' || !this.ctx.subagents.getProvider(provider)) {
      throw new WorkflowError(`no subagent provider registered for "${provider}"`, 'AGENT_START')
    }
    const requestedCap = request.maxTotalAgents ?? this.config.maxTotalAgents
    if (!Number.isSafeInteger(requestedCap) || requestedCap < 1 || requestedCap > this.config.maxTotalAgents) {
      throw new WorkflowError('workflow maxTotalAgents exceeds the engine ceiling', 'INVALID_ARGUMENT')
    }
    const id = WorkflowRunId(randomUUID())
    const info = { id, meta }
    const run = new IsolatedRun(this.ctx, id, meta, request, provider, {
      maxConcurrentAgents: this.config.maxConcurrentAgents,
      maxTotalAgents: this.config.maxTotalAgents,
      maxItemsPerCall: this.config.maxItemsPerCall,
      disposeGraceMs: this.config.disposeGraceMs,
    }, {
      phase: (title) => this.emitWorkflowEvent('workflow/phase', info, title),
      log: (message) => this.emitWorkflowEvent('workflow/log', info, message),
      agentStart: (agent) => this.emitWorkflowEvent('workflow/agent-start', info, agent),
      agentEnd: (agent, outcome) => this.emitWorkflowEvent('workflow/agent-end', info, { ...agent, outcome }),
    })
    this.emitWorkflowEvent('workflow/start', info)
    void run.result.then((result) => this.emitWorkflowEvent('workflow/end', info, {
      stopReason: result.stopReason, ...(result.error ? { error: result.error } : {}), agentsStarted: result.agentsStarted,
    }))
    return run
  }
}

function stageChildMain(): { file: string; dir: string } {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const source = [path.join(here, 'isolated-workflow-child.js'), path.join(here, 'isolated-workflow-child.ts')]
    .find((candidate) => existsSync(candidate))
  if (!source) throw new Error('isolated workflow child runtime is missing')
  const dir = mkdtempSync(path.join(tmpdir(), 'tars-ng-workflow-'))
  const dest = path.join(dir, path.basename(source))
  copyFileSync(source, dest)
  return { file: realpathSync(dest), dir: realpathSync(dir) }
}
