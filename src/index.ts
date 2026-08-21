import type { Context } from '@deepseek-ai/cordis'
import * as assistantPlugin from './plugins/assistant-plugin.js'
import * as memoryPlugin from './plugins/memory-plugin.js'

export const name = 'dsh-assistant'
export const inject = ['systemPrompt', 'agents']

/** Bundle entry: compose product plugins through public Cordis lifecycle. */
export function apply(ctx: Context) {
  ctx.plugin(memoryPlugin)
  ctx.plugin(assistantPlugin)
}

export { bootAssistantRuntime, createAssistantAgent } from './runtime/boot.js'
export { ASSISTANT_PERSONA } from './product/persona.js'
export * from './domain/memory/index.js'
