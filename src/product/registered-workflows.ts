import type { Context } from '@deepseek-ai/cordis'
import type { WorkflowMeta } from '@deepseek-ai/dsh-workflow'
import { defineTool } from '@deepseek-ai/dsh-tools'
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

const CATALOG = Object.freeze([{
  name: PARALLEL_ANALYSIS_META.name,
  title: 'Parallel analysis',
  description: PARALLEL_ANALYSIS_META.description,
  intent: 'read',
  engine: 'dsh-workflow',
}])

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
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_INPUT_BYTES) {
    throw new Error(`registered workflow input exceeds the ${MAX_INPUT_BYTES}-byte limit`)
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

/** Model-facing access is limited to a host catalog and fixed native scripts. */
export const name = 'dsh-assistant-registered-workflows'
export const inject = ['tools', 'systemPrompt', 'workflowEngine']

export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'product:registered-workflows',
    order: 51,
    text: 'Use list_registered_workflows and run_registered_workflow only for fixed workflows registered by the TARS-NG host. Runs are foreground and governed by the same child-agent, workspace, tool-policy, approval, cancellation, and depth boundaries as direct delegation. Model-authored workflow scripts are not supported.',
  })

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'list_registered_workflows',
    description: 'List trusted native DSH workflows registered by the TARS-NG host. Read-only; does not start work.',
    parameters: {},
    output: textOutput(),
    isConcurrencySafe: () => true,
    async execute() {
      return JSON.stringify(CATALOG)
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'run_registered_workflow',
    description: 'Run one trusted host-registered native DSH workflow in the foreground. This never accepts or executes model-authored script text.',
    parameters: {
      name: { type: 'string', required: true },
      input: { type: 'object', required: true, additionalProperties: true },
    },
    output: textOutput(),
    async execute(args, exec) {
      if (!exec.agent) throw new Error('registered workflows require a calling agent')
      if (args.name !== PARALLEL_ANALYSIS_META.name) throw new Error(`unknown registered workflow: ${args.name}`)
      const input = parseParallelAnalysisInput(args.input)
      const run = ctx.workflowEngine.start({
        meta: PARALLEL_ANALYSIS_META,
        script: PARALLEL_ANALYSIS_SCRIPT,
        args: input,
        parent: exec.agent,
        signal: exec.signal,
        subagentProvider: GOVERNED_SUBAGENT_PROVIDER,
        maxTotalAgents: MAX_ACTIVE_DELEGATIONS,
      })
      try {
        const result = await run.result
        if (result.stopReason !== 'completed') {
          throw new Error(`workflow ${result.stopReason}: ${result.error ?? 'no detail'}`)
        }
        return JSON.stringify({ runId: String(run.id), agentsStarted: result.agentsStarted, result: result.value })
      } finally {
        await run.dispose()
      }
    },
  })))
}
