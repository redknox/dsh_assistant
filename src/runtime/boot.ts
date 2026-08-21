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
import { persistCandidates, persistGovernance, openDurableSelfExtension, hydrateFromAuthority } from '../domain/self-extension/durable.js'
import { resolveAssistantHome } from '../domain/self-extension/home.js'
import { reconstructCommittedExtensions } from '../domain/self-extension/reconstruct.js'
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
  /** Durable Self-Extension home. Falls back to TARS_NG_HOME, then DSH_ASSISTANT_HOME. */
  home?: string
  /** When false, fixture integrations stay unavailable instead of returning realistic fake data. */
  allowFixtures?: boolean
}

export interface BootDiagnostics {
  readonly persistence: 'ok' | 'absent' | 'corrupt' | 'unknown-schema'
  readonly recoveryRequired: boolean
  readonly safeMode: boolean
  readonly reasons: readonly string[]
}

export interface AssistantControl {
  readonly ctx: Context
  readonly recoveryRoot: RecoveryRoot
  readonly diagnostics: BootDiagnostics
}

async function bootStack(options: BootOptions = {}): Promise<AssistantControl> {
  const opened = openDurableSelfExtension(options.home)
  const durable = opened.durable
  const persistBroken = opened.loadError !== undefined
  const safeMode = Boolean(options.safeMode) || persistBroken || Boolean(durable?.authority.snapshot().recovery.safeMode)
  const holder: { root?: RecoveryRoot } = {}

  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  if (!safeMode) await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  let recoveryRoot: RecoveryRoot | undefined
  await ctx.plugin(assistantProduct, {
    memory: options.memory,
    knowledge: { fixturePaths: options.knowledgeFixturePaths },
    integrations: options.allowFixtures === undefined ? undefined : { allowFixtures: options.allowFixtures },
    safeMode,
    jobs: safeMode ? { autoTickMs: null } : undefined,
    registry: durable === undefined ? undefined : { persistence: durable.authority },
    candidate: durable === undefined ? undefined : {
      workspaceRoot: durable.home.candidateArea,
      restore: persistBroken ? [] : durable.candidates.restore(durable.home.candidateArea),
      persist: (records) => persistCandidates(durable.candidates, records, ctx.capabilityRegistry),
    },
    review: durable === undefined ? undefined : {
      restore: persistBroken || durable.reviews.lineageUnavailable ? [] : durable.reviews.restore(),
      persist: persistBroken || durable.reviews.lineageUnavailable ? undefined : (reports) => durable.reviews.save(reports),
      hostLineage: true,
      lineageUnavailable: persistBroken || durable.reviews.lineageUnavailable,
    },
    governance: {
      hydrate: persistBroken || durable === undefined ? undefined : hydrateFromAuthority(durable.authority),
      persist: durable === undefined ? undefined : () => {
        if (holder.root) persistGovernance(durable.authority, holder.root.service.exportHydrate())
      },
      beginAuthorityCommit: durable === undefined ? undefined : () => durable.authority.beginDeferredWrites(),
      finishAuthorityCommit: durable === undefined ? undefined : () => durable.authority.endDeferredWrites(),
      durableHome: durable === undefined ? undefined : resolveAssistantHome(options.home),
      attachRecoveryRoot: (root) => {
        holder.root = root
        recoveryRoot = root
      },
    },
  })
  if (recoveryRoot === undefined) {
    throw new Error('bootstrap did not attach the recovery root')
  }

  const reconstruction = persistBroken
    ? { diagnostics: opened.diagnostics, safeMode: true, recoveryRequired: true }
    : await reconstructCommittedExtensions(recoveryRoot, durable)

  const persistence: BootDiagnostics['persistence'] = persistBroken
    ? (opened.loadError?.name === 'PersistenceSchemaError' ? 'unknown-schema' : 'corrupt')
    : durable === undefined ? 'absent' : 'ok'

  return {
    ctx,
    recoveryRoot,
    diagnostics: {
      persistence,
      recoveryRequired: reconstruction.recoveryRequired || persistBroken,
      safeMode: reconstruction.safeMode || persistBroken,
      reasons: [...opened.diagnostics, ...reconstruction.diagnostics],
    },
  }
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
