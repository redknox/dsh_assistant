import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

const MAX_DEPTH = 3
const MAX_ACTIVE = 4
const MAX_PROMPT_BYTES = 32 * 1024

const SAFE_CHILD_TOOLS = new Set([
  'delegate_task',
  'calendar_freebusy', 'calendar_get_event', 'calendar_list_events',
  'contacts_search', 'files_list', 'files_read', 'get_goal',
  'inspect_authoring_contract', 'inspect_candidate', 'inspect_candidate_review',
  'inspect_extension_governance', 'inspect_validation_diagnostics', 'integration_status',
  'job_list', 'job_output', 'list_candidate_files', 'list_capabilities',
  'list_registered_workflows', 'list_workbench', 'lookup_capability',
  'mail_get_message', 'mail_list_messages', 'read_candidate_file',
  'recall_memory', 'retrieve_knowledge', 'review_capability_resolution',
  'web_search',
])

function finalText(output: readonly ContentBlock[]): string {
  return output
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

export const name = 'dsh-assistant-governed-subagents'
export const inject = ['tools', 'systemPrompt', 'subagents']

export function apply(ctx: Context): void {
  let active = 0

  ctx.systemPrompt.section({
    name: 'product:governed-subagents',
    order: 52,
    text: 'Use delegate_task only for independent, self-contained analysis. Delegation is one-shot, read-only, limited to depth 3, and returns only the child final answer. Keep working locally when delegation is unnecessary.',
  })

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'delegate_task',
    description: 'Delegate one self-contained, read-only task to a fresh child agent and wait for its final answer. Maximum delegation depth is 3.',
    parameters: {
      description: { type: 'string', required: true, description: 'Short display label for the delegated task.' },
      prompt: { type: 'string', required: true, description: 'Complete standalone task; the child sees no parent conversation.' },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: value }] },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (!exec.agent) throw new Error('delegate_task requires a calling agent')
      if (Buffer.byteLength(args.prompt, 'utf8') > MAX_PROMPT_BYTES) throw new Error('delegated prompt exceeds 32768 bytes')
      if (active >= MAX_ACTIVE) throw new Error(`at most ${MAX_ACTIVE} subagents may run at once`)

      const allow = ctx.tools.schemas(exec.agent).map((tool) => tool.name).filter((tool) => SAFE_CHILD_TOOLS.has(tool))
      active += 1
      let run: Awaited<ReturnType<typeof ctx.subagents.start>> | undefined
      try {
        run = await ctx.subagents.start('tars-spawn', {
          label: args.description.slice(0, 80),
          prompt: [{ type: 'text', text: args.prompt }],
          parent: exec.agent,
          signal: exec.signal,
          maxDepth: MAX_DEPTH,
          toolFilter: { allow },
          agentOptions: { maxTokens: 4096 },
        })
        const result = await run.result
        if (result.stopReason !== 'completed') throw new Error(`subagent ended with ${result.stopReason}`)
        return finalText(result.output) || '(subagent completed without a text answer)'
      } finally {
        try {
          if (run) await run.dispose()
        } finally {
          active -= 1
        }
      }
    },
  })))
}
