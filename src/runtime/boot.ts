import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as assistantPlugin from '../plugins/assistant-plugin.js'
import * as memoryPlugin from '../plugins/memory-plugin.js'

/**
 * Minimal public DSH plugin stack for this product layer.
 * Depends only on public DSH package entrypoints, not package-internal implementation paths.
 */
export async function bootAssistantRuntime(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(memoryPlugin)
  await ctx.plugin(assistantPlugin)
  return ctx
}

export async function createAssistantAgent(ctx: Context, sessionId = 'dsh-assistant') {
  return ctx.agents.create({
    sessionId: SessionId(sessionId),
  })
}
