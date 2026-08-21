import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type AgentOptions } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { RecoveryRoot } from '../domain/governance/root.js'
import * as assistantProduct from '../product/bundle.js'
import type { MemoryPluginConfig } from '../plugins/memory-plugin.js'

/**
 * Minimal public DSH plugin stack for this product layer.
 * Depends only on public DSH package entrypoints, not package-internal implementation paths.
 */
export interface BootOptions {
  knowledgeFixturePaths?: string[]
  memory?: MemoryPluginConfig
  safeMode?: boolean
}

export interface AssistantControl {
  readonly ctx: Context
  readonly recoveryRoot: RecoveryRoot
}

async function bootStack(options: BootOptions = {}): Promise<AssistantControl> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  if (!options.safeMode) await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  let recoveryRoot: RecoveryRoot | undefined
  await ctx.plugin(assistantProduct, {
    memory: options.memory,
    knowledge: { fixturePaths: options.knowledgeFixturePaths },
    safeMode: options.safeMode,
    jobs: options.safeMode ? { autoTickMs: null } : undefined,
    governance: {
      attachRecoveryRoot: (root) => {
        recoveryRoot = root
      },
    },
  })
  if (recoveryRoot === undefined) {
    throw new Error('bootstrap did not attach the recovery root')
  }
  return { ctx, recoveryRoot }
}

export async function bootAssistantControl(options: BootOptions = {}): Promise<AssistantControl> {
  return bootStack(options)
}

export async function bootAssistantRuntime(options: BootOptions = {}): Promise<Context> {
  return (await bootStack(options)).ctx
}

/** Recovery/governance core without optional integrations, jobs, or generated extensions. */
export async function bootSafeModeRuntime(options: Omit<BootOptions, 'safeMode'> = {}): Promise<AssistantControl> {
  return bootStack({ ...options, safeMode: true })
}

export async function createAssistantAgent(
  ctx: Context,
  sessionId = 'dsh-assistant',
  agentOptions?: AgentOptions,
) {
  return ctx.agents.create({
    sessionId: SessionId(sessionId),
    ...(agentOptions ? { agentOptions } : {}),
  })
}
