import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { GOVERNED_SUBAGENT_PROVIDER, MAX_DELEGATION_DEPTH } from './governed-subagent-provider.js'

const MAX_PROMPT_BYTES = 32 * 1024

function finalText(output: readonly ContentBlock[]): string {
  return output
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

export const name = 'dsh-assistant-governed-subagents'
export const inject = ['tools', 'systemPrompt', 'subagents']

export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'product:governed-subagents',
    order: 52,
    text: `Use delegate_task only for independent, self-contained analysis. Delegation is one-shot, limited to depth ${MAX_DELEGATION_DEPTH}, and returns only the child final answer. Keep working locally when delegation is unnecessary. Child mutations remain governed by the same TARS-NG policy and approval boundary.`,
  })

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'delegate_task',
    description: `Delegate one self-contained task to a fresh governed child agent and wait for its final answer. Maximum delegation depth is ${MAX_DELEGATION_DEPTH}.`,
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
      let run: Awaited<ReturnType<typeof ctx.subagents.start>> | undefined
      try {
        run = await ctx.subagents.start(GOVERNED_SUBAGENT_PROVIDER, {
          label: args.description.slice(0, 80),
          prompt: [{ type: 'text', text: args.prompt }],
          parent: exec.agent,
          signal: exec.signal,
        })
        const result = await run.result
        if (result.stopReason !== 'completed') throw new Error(`subagent ended with ${result.stopReason}`)
        return finalText(result.output) || '(subagent completed without a text answer)'
      } finally {
        if (run) await run.dispose()
      }
    },
  })))
}
