import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

function textOutput() {
  return {
    schema: { type: 'string' as const },
    render(_args: unknown, value: string) {
      return [{ type: 'text' as const, text: value }]
    },
  }
}

/**
 * Expose only host-registered workflows. There is deliberately no script field:
 * orchestration implementation remains trusted host code behind this interface.
 */
export const name = 'dsh-assistant-registered-workflows'
export const inject = ['tools', 'systemPrompt', 'assistantJobs', 'jobs', 'agents']

export async function apply(ctx: Context): Promise<void> {
  ctx.systemPrompt.section({
    name: 'product:registered-workflows',
    order: 51,
    text: 'Use list_registered_workflows and run_registered_workflow only for host-registered workflows. The returned job id is session-owned. Use job_output to collect it and job_kill when it no longer matters. No model-authored workflow scripts are supported.',
  })

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'list_registered_workflows',
    description: 'List trusted workflows registered by the TARS-NG host. Read-only; does not start work.',
    parameters: {},
    output: textOutput(),
    isConcurrencySafe: () => true,
    async execute() {
      return JSON.stringify(ctx.assistantJobs.service.list().map((workflow) => ({
        name: workflow.name,
        title: workflow.title,
        intent: workflow.intent,
        schedule: workflow.schedule,
      })))
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'run_registered_workflow',
    description: 'Start one trusted host-registered workflow as a session-owned background job. This never accepts or executes a script. Collect the returned job id with job_output.',
    parameters: {
      name: { type: 'string', required: true },
      input: { type: 'object', additionalProperties: true },
    },
    output: textOutput(),
    async execute(args, exec) {
      if (!exec.agent) throw new Error('registered workflows require a calling agent')
      if (Buffer.byteLength(JSON.stringify(args.input ?? {}), 'utf8') > 16 * 1024) {
        throw new Error('registered workflow input exceeds the 16384-byte limit')
      }
      const started = ctx.assistantJobs.service.start(args.name, args.input ?? {}, exec.agent)
      return JSON.stringify({ runId: started.runId, jobId: String(started.jobId) })
    },
  })))
}
