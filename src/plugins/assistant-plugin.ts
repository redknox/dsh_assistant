import type { Context } from '@deepseek-ai/cordis'
import { ASSISTANT_PERSONA } from '../product/persona.js'

export const name = 'dsh-assistant'
export const inject = ['systemPrompt']

/** Product guidance as a distinct public prompt section (does not replace Harness identity). */
export function apply(ctx: Context) {
  ctx.systemPrompt.section({
    name: 'product:assistant',
    order: 10,
    text: ASSISTANT_PERSONA,
  })
}
