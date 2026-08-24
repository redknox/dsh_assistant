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

export type OfficialExclusionReason =
  | 'dsh-host-cli'
  | 'dsh-dev-loader'
  | 'dsh-host-telemetry'
  | 'ungoverned-cli-tool'
  | 'multi-agent-out-of-scope'
  | 'skill-lifecycle-out-of-scope'
  | 'replaced-by-product-policy'
  | 'replaced-by-product-sandbox'

export type AdapterWhen = 'always' | 'ready' | 'session-persistence'

export type OfficialIdMapping =
  | { readonly official: string; readonly kind: 'mount'; readonly runtime: string; readonly when: AdapterWhen }
  | { readonly official: string; readonly kind: 'exclude'; readonly reason: OfficialExclusionReason }

export type ProductOnlySeam = { readonly runtime: string; readonly when: AdapterWhen; readonly reason: string }

export const OFFICIAL_ID_CONTRACT = Object.freeze([
  { official: 'dsh-assistant', kind: 'mount', runtime: 'dsh-assistant', when: 'always' },
  { official: 'agent', kind: 'mount', runtime: 'AgentRegistry', when: 'always' },
  { official: 'agent-default-model', kind: 'mount', runtime: 'AgentDefaultModelConfig', when: 'always' },
  { official: 'agent-loop', kind: 'mount', runtime: 'AgentLoop', when: 'always' },
  { official: 'session', kind: 'mount', runtime: 'SessionStore', when: 'always' },
  { official: 'llm', kind: 'mount', runtime: 'LlmRuntime', when: 'always' },
  { official: 'llm-deepseek', kind: 'mount', runtime: 'llm-deepseek', when: 'always' },
  { official: 'system-prompt', kind: 'mount', runtime: 'SystemPrompt', when: 'always' },
  { official: 'tools', kind: 'mount', runtime: 'ToolRuntime', when: 'always' },
  { official: 'jobs', kind: 'mount', runtime: 'LocalJobRegistry', when: 'ready' },
  { official: 'session-persistence-jsonl', kind: 'mount', runtime: 'JsonlSessionPersistence', when: 'session-persistence' },
  { official: 'timer', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'hmr', kind: 'exclude', reason: 'dsh-dev-loader' },
  { official: 'typert', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'typert-loader', kind: 'exclude', reason: 'dsh-dev-loader' },
  { official: 'typert-gateway', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'session-title', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'session-title-llm', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'user-questions', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'llm-retry', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'settings', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'credentials', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'llm-pi-ai', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'attachment-local', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'session-query-sqlite', kind: 'exclude', reason: 'dsh-host-telemetry' },
  { official: 'session-projection', kind: 'exclude', reason: 'dsh-host-telemetry' },
  { official: 'session-telemetry-otel', kind: 'exclude', reason: 'dsh-host-telemetry' },
  { official: 'subprocess', kind: 'exclude', reason: 'ungoverned-cli-tool' },
  { official: 'sandbox', kind: 'exclude', reason: 'replaced-by-product-sandbox' },
  { official: 'sandbox-policy', kind: 'exclude', reason: 'replaced-by-product-sandbox' },
  { official: 'bash-sandbox', kind: 'exclude', reason: 'replaced-by-product-sandbox' },
  { official: 'pwsh-sandbox', kind: 'exclude', reason: 'replaced-by-product-sandbox' },
  { official: 'approval', kind: 'exclude', reason: 'replaced-by-product-policy' },
  { official: 'permission', kind: 'exclude', reason: 'replaced-by-product-policy' },
  { official: 'shell-env', kind: 'exclude', reason: 'ungoverned-cli-tool' },
  { official: 'tool-bash', kind: 'exclude', reason: 'ungoverned-cli-tool' },
  { official: 'tool-pwsh', kind: 'exclude', reason: 'ungoverned-cli-tool' },
  { official: 'tool-jobs', kind: 'exclude', reason: 'ungoverned-cli-tool' },
  { official: 'fs-observation-policy', kind: 'exclude', reason: 'replaced-by-product-sandbox' },
  { official: 'tool-fs', kind: 'exclude', reason: 'replaced-by-product-sandbox' },
  { official: 'tool-fs-search', kind: 'exclude', reason: 'replaced-by-product-sandbox' },
  { official: 'agent-instructions', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'skill', kind: 'exclude', reason: 'skill-lifecycle-out-of-scope' },
  { official: 'skill-filesystem', kind: 'exclude', reason: 'skill-lifecycle-out-of-scope' },
  { official: 'skill-badge', kind: 'exclude', reason: 'skill-lifecycle-out-of-scope' },
  { official: 'tool-skill', kind: 'exclude', reason: 'skill-lifecycle-out-of-scope' },
  { official: 'commands', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'command-feedback', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'goal', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'goal-round-driver', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'command-goal', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'plan-mode', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'token-meter', kind: 'exclude', reason: 'dsh-host-telemetry' },
  { official: 'compaction-basic', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'command-compact', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'subagent', kind: 'exclude', reason: 'multi-agent-out-of-scope' },
  { official: 'subagent-spawn-in-process', kind: 'exclude', reason: 'multi-agent-out-of-scope' },
  { official: 'subagent-fork-in-process', kind: 'exclude', reason: 'multi-agent-out-of-scope' },
  { official: 'tool-subagent-control', kind: 'exclude', reason: 'multi-agent-out-of-scope' },
  { official: 'tool-subagent-list-agents', kind: 'exclude', reason: 'multi-agent-out-of-scope' },
  { official: 'tool-subagent', kind: 'exclude', reason: 'multi-agent-out-of-scope' },
  { official: 'tool-subagent-fork', kind: 'exclude', reason: 'multi-agent-out-of-scope' },
  { official: 'tool-subagent-report', kind: 'exclude', reason: 'multi-agent-out-of-scope' },
  { official: 'workflow-worker-thread', kind: 'exclude', reason: 'multi-agent-out-of-scope' },
  { official: 'tool-workflow', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'timeout-policy', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'spill-local', kind: 'exclude', reason: 'dsh-host-telemetry' },
  { official: 'spill-policy', kind: 'exclude', reason: 'dsh-host-telemetry' },
  { official: 'session-checkpoint-policy', kind: 'exclude', reason: 'dsh-host-telemetry' },
  { official: 'tool-result-pruner', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'tool-todo', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'tool-goal', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'tool-ralph', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'tool-str-replace-editor', kind: 'exclude', reason: 'ungoverned-cli-tool' },
  { official: 'repeat-tool-reminder', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'web', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'web-search-deepseek', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'tool-web', kind: 'exclude', reason: 'dsh-host-cli' },
  { official: 'fs-sandbox', kind: 'exclude', reason: 'replaced-by-product-sandbox' },
] as const satisfies readonly OfficialIdMapping[])

export const PRODUCT_ONLY_SEAMS = Object.freeze([
  { runtime: 'InvariantRegistry', when: 'always', reason: 'product recovery/governance invariants' },
  { runtime: 'dsh-assistant-candidate', when: 'always', reason: 'Candidate Workbench storage' },
  { runtime: 'dsh-assistant-governance', when: 'always', reason: 'human approval and recovery authority' },
  { runtime: 'dsh-assistant-personality', when: 'always', reason: 'TARS-NG personality' },
  { runtime: 'dsh-assistant-registry', when: 'always', reason: 'capability registry' },
  { runtime: 'dsh-assistant-resolution', when: 'always', reason: 'capability resolution' },
  { runtime: 'dsh-assistant-review', when: 'always', reason: 'independent review' },
  { runtime: 'dsh-assistant-workbench', when: 'always', reason: 'Candidate Workbench' },
  { runtime: 'dsh-assistant-integrations', when: 'ready', reason: 'product integration hub' },
  { runtime: 'dsh-assistant-jobs', when: 'ready', reason: 'assistant job workflows' },
  { runtime: 'dsh-assistant-knowledge', when: 'ready', reason: 'personal knowledge' },
  { runtime: 'dsh-assistant-memory', when: 'ready', reason: 'personal memory' },
  { runtime: 'dsh-assistant-policy', when: 'ready', reason: 'product trust policy' },
] as const satisfies readonly ProductOnlySeam[])

export const PROTECTED_PLUGIN_IDS = Object.freeze(['dsh-assistant'] as const)

export interface ProfilePatchRow {
  readonly id?: string
  readonly disabled?: boolean
  readonly config?: unknown
}

function mappingApplies(when: AdapterWhen, options: { readonly safeMode?: boolean; readonly sessionPersistence?: boolean }): boolean {
  if (when === 'ready') return options.safeMode !== true
  if (when === 'session-persistence') return options.sessionPersistence === true
  return true
}

export function expectedProductionAdapterIds(options: {
  readonly safeMode?: boolean
  readonly sessionPersistence?: boolean
} = {}): readonly string[] {
  const ids = new Set<string>()
  for (const row of OFFICIAL_ID_CONTRACT) {
    if (row.kind === 'mount' && mappingApplies(row.when, options)) ids.add(row.runtime)
  }
  for (const row of PRODUCT_ONLY_SEAMS) {
    if (mappingApplies(row.when, options)) ids.add(row.runtime)
  }
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

export function assertOfficialIdContract(): void {
  const official = new Set<string>(ASSISTANT_OFFICIAL_COMPOSED_IDS)
  const mapped = new Set<string>()
  for (const row of OFFICIAL_ID_CONTRACT) {
    if (mapped.has(row.official)) {
      throw new RuntimeContextError(`official id ${row.official} is mapped twice`)
    }
    mapped.add(row.official)
    if (!official.has(row.official)) {
      throw new RuntimeContextError(`official id contract contains unknown id ${row.official}`)
    }
  }
  for (const id of ASSISTANT_OFFICIAL_COMPOSED_IDS) {
    if (!mapped.has(id)) {
      throw new RuntimeContextError(`official composed id ${id} has no adapter mapping or exclusion`)
    }
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
  const expected = [...ASSISTANT_OFFICIAL_COMPOSED_IDS]
  const actual = [...composedIds]
  if (expected.length !== actual.length || expected.some((id, index) => actual[index] !== id)) {
    throw new RuntimeContextError('official composed profile does not match the shipped assistant contract')
  }
}

export function assertOfficialEquivalentToAdapter(
  composedIds: readonly string[],
  mountedIds: readonly string[],
  options: { readonly safeMode?: boolean; readonly sessionPersistence?: boolean } = {},
): void {
  assertOfficialIdContract()
  assertOfficialComposedIds(composedIds)
  const expected = expectedProductionAdapterIds(options)
  const actual = [...new Set(mountedIds)].sort()
  if (actual.length !== expected.length || expected.some((id, index) => actual[index] !== id)) {
    throw new RuntimeContextError(`official composition is not equivalent to the production adapter: expected ${expected.join(',')} actual ${actual.join(',')}`)
  }
}

export function assertMountedAdapterContract(
  ctx: Context,
  options: { readonly safeMode?: boolean; readonly sessionPersistence?: boolean } = {},
): void {
  assertOfficialEquivalentToAdapter(ASSISTANT_OFFICIAL_COMPOSED_IDS, mountedAdapterPluginIds(ctx), options)
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
  assertOfficialIdContract()
  if (expectedProductionAdapterIds({}).filter((id) => id === 'dsh-assistant').length !== 1) {
    throw new RuntimeContextError('production adapter contract is missing dsh-assistant')
  }
}
