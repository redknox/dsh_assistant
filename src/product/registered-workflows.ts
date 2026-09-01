import { Service, type Context } from '@deepseek-ai/cordis'
import type { WorkflowMeta } from '@deepseek-ai/dsh-workflow'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { GovernedWorkflowCatalog, type GovernedWorkflowDefinition, type WorkflowCatalogView } from '../domain/workflow-catalog/index.js'
import { GOVERNED_SUBAGENT_PROVIDER, MAX_ACTIVE_DELEGATIONS } from './governed-subagent-provider.js'

const MAX_INPUT_BYTES = 32 * 1024
const MAX_PROMPT_BYTES = 16 * 1024
const MAX_FIELD_BYTES = 80

const PARALLEL_ANALYSIS_META: WorkflowMeta = {
  name: 'parallel-analysis',
  description: 'Run independent analysis tasks through bounded TARS-NG child agents.',
  whenToUse: 'Use when two or more independent questions can be investigated in parallel.',
  phases: [{ title: 'Analyze', detail: 'Independent governed analysis.' }],
}

// Trusted host source: the model supplies data only and never supplies script text.
const PARALLEL_ANALYSIS_SCRIPT = `
phase('Analyze')
const results = await parallel(args.tasks.map((task) => async () => ({
  id: task.id,
  result: await agent(task.prompt, { label: task.label, phase: 'Analyze' }),
})))
return { results }
`

interface AnalysisTask {
  readonly id: string
  readonly label: string
  readonly prompt: string
}

interface ParallelAnalysisInput {
  readonly tasks: readonly AnalysisTask[]
}

function textOutput() {
  return {
    schema: { type: 'string' as const },
    render(_args: unknown, value: string) {
      return [{ type: 'text' as const, text: value }]
    },
  }
}

function boundedString(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`)
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw new Error(`${field} exceeds the ${maxBytes}-byte limit`)
  return value
}

function parseParallelAnalysisInput(value: unknown): ParallelAnalysisInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('parallel-analysis input must be an object')
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => key !== 'tasks')) throw new Error('parallel-analysis input contains an unknown field')
  if (!Array.isArray(record.tasks) || record.tasks.length < 1 || record.tasks.length > MAX_ACTIVE_DELEGATIONS) {
    throw new Error(`parallel-analysis requires 1-${MAX_ACTIVE_DELEGATIONS} tasks`)
  }
  return {
    tasks: record.tasks.map((item, index) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`tasks[${index}] must be an object`)
      }
      const task = item as Record<string, unknown>
      if (Object.keys(task).some((key) => !['id', 'label', 'prompt'].includes(key))) {
        throw new Error(`tasks[${index}] contains an unknown field`)
      }
      return {
        id: boundedString(task.id, `tasks[${index}].id`, MAX_FIELD_BYTES),
        label: boundedString(task.label, `tasks[${index}].label`, MAX_FIELD_BYTES),
        prompt: boundedString(task.prompt, `tasks[${index}].prompt`, MAX_PROMPT_BYTES),
      }
    }),
  }
}

/** Model-facing execution is limited to exact active Catalog names; inline scripts never cross the tool seam. */
export const name = 'dsh-assistant-registered-workflows'
export const inject = ['tools', 'systemPrompt', 'workflowEngine']

declare module '@deepseek-ai/cordis' {
  interface Context {
    workflowCatalog: RegisteredWorkflowCatalogService
  }
}

export class RegisteredWorkflowCatalogService extends Service {
  constructor(ctx: Context, private readonly catalog: GovernedWorkflowCatalog) {
    super(ctx, 'workflowCatalog')
  }

  list(): WorkflowCatalogView {
    return this.catalog.list()
  }

  execute(...args: Parameters<GovernedWorkflowCatalog['execute']>) {
    return this.catalog.execute(...args)
  }

  register<Input>(definition: GovernedWorkflowDefinition<Input>): () => void {
    return this.catalog.register(definition)
  }
}

export async function apply(ctx: Context): Promise<void> {
  const catalog = new GovernedWorkflowCatalog(ctx.workflowEngine, GOVERNED_SUBAGENT_PROVIDER, MAX_ACTIVE_DELEGATIONS)
  catalog.register({
    meta: PARALLEL_ANALYSIS_META,
    title: 'Parallel analysis',
    script: PARALLEL_ANALYSIS_SCRIPT,
    owner: 'managed/workflow-runtime',
    version: '0.1.0',
    provenance: 'managed',
    intent: 'read',
    inputFields: [{ name: 'tasks', required: true, description: 'One to four independent analysis tasks.' }],
    maxInputBytes: MAX_INPUT_BYTES,
    maxTotalAgents: MAX_ACTIVE_DELEGATIONS,
    parseInput: parseParallelAnalysisInput,
  })
  await ctx.plugin(class extends RegisteredWorkflowCatalogService {
    constructor(scope: Context) {
      super(scope, catalog)
    }
  })
  ctx.systemPrompt.section({
    name: 'product:registered-workflows',
    order: 51,
    text: 'Use list_registered_workflows and run_registered_workflow only for active workflows registered in the TARS-NG Catalog. Runs are foreground and governed by the same child-agent, workspace, tool-policy, approval, cancellation, and depth boundaries as direct delegation. Never pass inline JavaScript to execution. A missing reusable workflow may be authored only as a Candidate, then validated, sealed, independently reviewed, exactly approved, and human-activated before use.',
  })

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'list_registered_workflows',
    description: 'List active governed native DSH workflows in the TARS-NG Catalog. Read-only; does not start work.',
    parameters: {},
    output: textOutput(),
    isConcurrencySafe: () => true,
    async execute() {
      return JSON.stringify(catalog.list().workflows)
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'run_registered_workflow',
    description: 'Run one exact active governed native DSH workflow in the foreground. This accepts only Catalog name and input, never inline script text.',
    parameters: {
      name: { type: 'string', required: true },
      input: { type: 'object', required: true, additionalProperties: true },
    },
    output: textOutput(),
    async execute(args, exec) {
      if (!exec.agent) throw new Error('registered workflows require a calling agent')
      const result = await catalog.execute(args.name, args.input, {
        parent: exec.agent,
        ...(exec.signal ? { signal: exec.signal } : {}),
      })
      return JSON.stringify(result)
    },
  })))
}
