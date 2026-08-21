import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as assistantPlugin from '../plugins/assistant-plugin.js'
import * as integrationsPlugin from '../plugins/integrations-plugin.js'
import * as knowledgePlugin from '../plugins/knowledge-plugin.js'
import * as memoryPlugin from '../plugins/memory-plugin.js'
import * as jobsPlugin from '../plugins/jobs-plugin.js'
import * as policyPlugin from '../plugins/policy-plugin.js'

/**
 * Minimal public DSH plugin stack for this product layer.
 * Depends only on public DSH package entrypoints, not package-internal implementation paths.
 */
export interface BootOptions {
  knowledgeFixturePaths?: string[]
}

export async function bootAssistantRuntime(options: BootOptions = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(memoryPlugin)
  await ctx.plugin(knowledgePlugin, { fixturePaths: options.knowledgeFixturePaths })
  await ctx.plugin(integrationsPlugin)
  await ctx.plugin(policyPlugin)
  await ctx.plugin(jobsPlugin)
  await ctx.plugin(assistantPlugin)
  return ctx
}

export async function createAssistantAgent(ctx: Context, sessionId = 'dsh-assistant') {
  return ctx.agents.create({
    sessionId: SessionId(sessionId),
  })
}
