import { Service, type Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRuntime } from '@deepseek-ai/dsh-tools'
import { ClaudeCodeDevelopmentExecutor, CodexDevelopmentExecutor, type LocalCliExecutorOptions } from '../adapters/development-executor/local-cli.js'
import {
  DevelopmentExecutorService,
  type DevelopmentExecutorHub,
  type ExternalDevelopmentExecutorId,
} from '../domain/development-executor/index.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    developmentExecutors: DevelopmentExecutorHub
  }
}

export interface DevelopmentExecutorPluginConfig {
  readonly inspectOnly?: boolean
  readonly codex?: LocalCliExecutorOptions
  readonly claudeCode?: LocalCliExecutorOptions
}

export class DevelopmentExecutorHubService extends Service implements DevelopmentExecutorHub {
  constructor(ctx: Context, private readonly hub: DevelopmentExecutorHub) {
    super(ctx, 'developmentExecutors')
  }
  inspect() { return this.hub.inspect() }
  develop(input: Parameters<DevelopmentExecutorHub['develop']>[0]) { return this.hub.develop(input) }
}

export const DEVELOPMENT_EXECUTOR_GUIDANCE = [
  'TARS-NG Native remains the default development path and uses the existing Candidate Workbench authoring tools.',
  'Codex and Claude Code are optional external Development Executors, not new governance authorities.',
  'Use inspect_development_executors before recommending an external executor.',
  'Only delegate after the user has accepted the Resolution Plan and a mutable Candidate exists.',
  'Choose an executor based on the task and user preference; never imply that external execution is required.',
  'delegate_candidate_development always requires a one-shot human approval and returns to TARS-NG validation afterward.',
  'External executors cannot change manifests, approve, activate, publish, push, merge, or escape the Candidate workspace.',
].join(' ')

export const name = 'dsh-assistant-development-executors'
export const inject = ['candidateWorkspace', 'candidateWorkbench', 'systemPrompt', 'tools']

export async function apply(ctx: Context, config: DevelopmentExecutorPluginConfig = {}) {
  const hub = new DevelopmentExecutorService(ctx.candidateWorkspace, ctx.candidateWorkbench, [
    new CodexDevelopmentExecutor(config.codex),
    new ClaudeCodeDevelopmentExecutor(config.claudeCode),
  ])
  await ctx.plugin(class extends DevelopmentExecutorHubService {
    constructor(scope: Context) { super(scope, hub) }
  })
  ctx.systemPrompt.section({
    name: 'product:development-executors',
    order: 46,
    text: DEVELOPMENT_EXECUTOR_GUIDANCE,
  })
  ctx.effect(() => registerDevelopmentExecutorTools(ctx.tools, hub, config.inspectOnly === true))
  if (!config.inspectOnly) {
    ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => (
      exec.name === 'delegate_candidate_development'
        ? { kind: 'ask' as const, reason: 'Run an external coding agent once inside this governed Candidate workspace. It may edit candidate source and consume the selected provider account.' }
        : next()
    )))
  }
}

function registerDevelopmentExecutorTools(
  tools: Pick<ToolRuntime, 'register'>,
  hub: DevelopmentExecutorHub,
  inspectOnly: boolean,
): () => void {
  const output = {
    schema: { type: 'string' as const },
    render(_args: unknown, value: string) { return [{ type: 'text' as const, text: value }] },
  }
  const disposeInspect = tools.register(defineTool({
    name: 'inspect_development_executors',
    description: 'List the three candidate-authoring paths: TARS-NG Native, Codex, and Claude Code. Read-only.',
    parameters: {},
    output,
    async execute() { return JSON.stringify({ executors: hub.inspect(), default: 'native' }) },
  }))
  if (inspectOnly) return disposeInspect

  const disposeDevelop = tools.register(defineTool({
    name: 'delegate_candidate_development',
    description: 'After an accepted Resolution Plan, delegate implementation of one mutable Candidate to Codex or Claude Code. Requires human approval. TARS-NG Native uses existing authoring tools and is not invoked here.',
    parameters: {
      candidateId: { type: 'string', required: true },
      executor: { type: 'string', required: true, description: 'codex or claude-code' },
      instructions: { type: 'string' },
    },
    output,
    async execute(args, exec) {
      const executor = String(args.executor)
      if (executor !== 'codex' && executor !== 'claude-code') {
        throw new Error('executor must be codex or claude-code; use Candidate Workbench tools for TARS-NG Native')
      }
      return JSON.stringify(await hub.develop({
        candidateId: String(args.candidateId),
        executor: executor as ExternalDevelopmentExecutorId,
        ...(typeof args.instructions === 'string' && args.instructions !== '' ? { instructions: args.instructions } : {}),
        signal: exec.signal,
      }))
    },
  }))
  return () => {
    disposeInspect()
    disposeDevelop()
  }
}
