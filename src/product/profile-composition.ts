import type { Context } from '@deepseek-ai/cordis'
import { RuntimeContextError } from './runtime-context.js'

export const ASSISTANT_PROFILE_BUNDLES = Object.freeze(['@deepseek-ai/dsh-base', 'dsh-assistant'] as const)

/** Official `loadProfile` / `composeEntries` ids for packaged `assistant`. Extra unknown ids fail closed. */
export const ASSISTANT_OFFICIAL_COMPOSED_IDS = Object.freeze([
  'timer',
  'hmr',
  'llm',
  'session',
  'typert',
  'typert-loader',
  'typert-gateway',
  'session-title',
  'session-title-llm',
  'user-questions',
  'agent',
  'agent-default-model',
  'jobs',
  'llm-retry',
  'settings',
  'credentials',
  'llm-pi-ai',
  'session-persistence-jsonl',
  'attachment-local',
  'session-query-sqlite',
  'session-projection',
  'session-telemetry-otel',
  'subprocess',
  'sandbox',
  'sandbox-policy',
  'bash-sandbox',
  'pwsh-sandbox',
  'approval',
  'permission',
  'shell-env',
  'tool-bash',
  'tool-pwsh',
  'tool-jobs',
  'fs-observation-policy',
  'tool-fs',
  'tool-fs-search',
  'agent-instructions',
  'skill',
  'skill-filesystem',
  'skill-badge',
  'tool-skill',
  'commands',
  'command-feedback',
  'goal',
  'goal-round-driver',
  'command-goal',
  'plan-mode',
  'token-meter',
  'compaction-basic',
  'command-compact',
  'subagent',
  'subagent-spawn-in-process',
  'subagent-fork-in-process',
  'tool-subagent-control',
  'tool-subagent-list-agents',
  'tool-subagent',
  'tool-subagent-fork',
  'tool-subagent-report',
  'workflow-worker-thread',
  'tool-workflow',
  'timeout-policy',
  'spill-local',
  'spill-policy',
  'session-checkpoint-policy',
  'tool-result-pruner',
  'tool-todo',
  'tool-goal',
  'tool-ralph',
  'tool-str-replace-editor',
  'repeat-tool-reminder',
  'web',
  'web-search-deepseek',
  'tool-web',
  'tools',
  'system-prompt',
  'agent-loop',
  'fs-sandbox',
  'llm-deepseek',
  'dsh-assistant',
] as const)

export const OFFICIAL_ADAPTER_SHARED_IDS = Object.freeze([
  'dsh-assistant',
  'agent',
  'agent-default-model',
  'agent-loop',
  'session',
  'llm',
  'llm-deepseek',
  'system-prompt',
  'tools',
] as const)

export const PRODUCTION_ADAPTER_CORE_IDS = Object.freeze([
  'AgentDefaultModelConfig',
  'AgentLoop',
  'AgentRegistry',
  'InvariantRegistry',
  'LlmRuntime',
  'SessionStore',
  'SystemPrompt',
  'ToolRuntime',
  'dsh-assistant',
  'dsh-assistant-candidate',
  'dsh-assistant-governance',
  'dsh-assistant-personality',
  'dsh-assistant-registry',
  'dsh-assistant-resolution',
  'dsh-assistant-review',
  'dsh-assistant-workbench',
  'llm-deepseek',
] as const)

export const PRODUCTION_ADAPTER_OPTIONAL_IDS = Object.freeze([
  'LocalJobRegistry',
  'dsh-assistant-integrations',
  'dsh-assistant-jobs',
  'dsh-assistant-knowledge',
  'dsh-assistant-memory',
  'dsh-assistant-policy',
  'JsonlSessionPersistence',
] as const)

export const PROTECTED_PLUGIN_IDS = Object.freeze(['dsh-assistant'] as const)

export interface ProfilePatchRow {
  readonly id?: string
  readonly disabled?: boolean
  readonly config?: unknown
}

export function expectedProductionAdapterIds(options: {
  readonly safeMode?: boolean
  readonly sessionPersistence?: boolean
} = {}): readonly string[] {
  const ids = new Set<string>(PRODUCTION_ADAPTER_CORE_IDS)
  if (options.safeMode !== true) {
    for (const id of PRODUCTION_ADAPTER_OPTIONAL_IDS) {
      if (id !== 'JsonlSessionPersistence') ids.add(id)
    }
  }
  if (options.sessionPersistence === true) ids.add('JsonlSessionPersistence')
  return [...ids].sort()
}

export function mountedAdapterPluginIds(ctx: Context): string[] {
  return [...new Set([...ctx.registry.values()].map((runtime) => runtime.name).filter((name): name is string => typeof name === 'string' && name !== ''))].sort()
}

export function assertAssistantBundles(bundles: readonly string[]): void {
  if (bundles.length !== ASSISTANT_PROFILE_BUNDLES.length
    || ASSISTANT_PROFILE_BUNDLES.some((item, index) => bundles[index] !== item)) {
    throw new RuntimeContextError('assistant profile bundles are not the production adapter contract')
  }
}

export function assertOfficialComposedIds(composedIds: readonly string[]): void {
  const product = composedIds.filter((id) => id === 'dsh-assistant')
  if (product.length !== 1) {
    throw new RuntimeContextError('composed profile must mount exactly one dsh-assistant bundle')
  }
  if (new Set(composedIds).size !== composedIds.length) {
    throw new RuntimeContextError('composed profile contains duplicate plugin ids')
  }
  const official = [...ASSISTANT_OFFICIAL_COMPOSED_IDS]
  const actual = [...composedIds]
  if (official.length !== actual.length || official.some((id, index) => actual[index] !== id)) {
    throw new RuntimeContextError('official composed profile does not match the shipped assistant contract')
  }
  for (const id of OFFICIAL_ADAPTER_SHARED_IDS) {
    if (!composedIds.includes(id)) {
      throw new RuntimeContextError(`composed profile is missing required adapter id ${id}`)
    }
  }
}

export function assertOfficialEquivalentToAdapter(composedIds: readonly string[], mountedIds: readonly string[]): void {
  assertOfficialComposedIds(composedIds)
  for (const id of OFFICIAL_ADAPTER_SHARED_IDS) {
    if (!mountedIds.includes(id) && id !== 'agent' && id !== 'session' && id !== 'llm' && id !== 'tools' && id !== 'system-prompt' && id !== 'agent-loop' && id !== 'agent-default-model') {
      if (id === 'dsh-assistant' && !mountedIds.includes('dsh-assistant')) {
        throw new RuntimeContextError('production adapter did not mount dsh-assistant')
      }
    }
  }
  if (!mountedIds.includes('dsh-assistant')) {
    throw new RuntimeContextError('production adapter did not mount dsh-assistant')
  }
  const sharedOfficial = OFFICIAL_ADAPTER_SHARED_IDS.filter((id) => composedIds.includes(id))
  if (sharedOfficial.length !== OFFICIAL_ADAPTER_SHARED_IDS.length) {
    throw new RuntimeContextError('official composition is missing shared adapter surface')
  }
}

export function assertMountedAdapterContract(
  ctx: Context,
  options: { readonly safeMode?: boolean; readonly sessionPersistence?: boolean } = {},
): void {
  const actual = mountedAdapterPluginIds(ctx)
  const expected = expectedProductionAdapterIds(options)
  if (actual.length !== expected.length || expected.some((id, index) => actual[index] !== id)) {
    throw new RuntimeContextError(`production boot stack does not match the assistant adapter contract: expected ${expected.join(',')} actual ${actual.join(',')}`)
  }
}

export function assertProfilePatchSafe(patches: readonly ProfilePatchRow[]): void {
  for (const row of patches) {
    if (row.id !== undefined && (PROTECTED_PLUGIN_IDS as readonly string[]).includes(row.id) && row.disabled === true) {
      throw new RuntimeContextError(`profile patch cannot disable protected plugin ${row.id}`)
    }
    if (row.id === 'dsh-assistant' && row.config !== undefined && row.config !== null && typeof row.config === 'object') {
      const config = row.config as { governance?: unknown; registry?: unknown }
      if (config.governance === null || config.registry === null) {
        throw new RuntimeContextError('profile patch cannot remove protected governance or registry authority')
      }
    }
  }
}

export function assertSelectedProfile(profile: string): void {
  if (profile !== 'assistant') {
    throw new RuntimeContextError('unknown or invalid profile')
  }
}

export function assertAssistantAdapterContract(): void {
  assertAssistantBundles(ASSISTANT_PROFILE_BUNDLES)
  if (ASSISTANT_OFFICIAL_COMPOSED_IDS.filter((id) => id === 'dsh-assistant').length !== 1) {
    throw new RuntimeContextError('assistant adapter contract must name exactly one dsh-assistant')
  }
  for (const id of OFFICIAL_ADAPTER_SHARED_IDS) {
    if (!(ASSISTANT_OFFICIAL_COMPOSED_IDS as readonly string[]).includes(id)) {
      throw new RuntimeContextError(`assistant adapter contract is missing shared id ${id}`)
    }
  }
  if (!(PRODUCTION_ADAPTER_CORE_IDS as readonly string[]).includes('dsh-assistant')) {
    throw new RuntimeContextError('production adapter contract is missing dsh-assistant')
  }
}
