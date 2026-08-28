import type { Context } from '@deepseek-ai/cordis'
import {
  activeComposedIds,
  loadGovernedAssistantComposition,
  type ComposedProfileEntry,
  type GovernedProfileComposition,
} from './profile-load.js'
import { RuntimeContextError } from './runtime-context.js'

export const ASSISTANT_PROFILE_BUNDLES = Object.freeze(['@deepseek-ai/dsh-base', 'dsh-assistant'] as const)

/** Unpatched `dsh-base` + `dsh-assistant` compose order. Extra unknown ids fail closed. */
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

export type AdapterWhen = 'always' | 'ready' | 'session-persistence'

export type OfficialRuntimeMount = {
  readonly official: string
  readonly runtime: string
  readonly when: AdapterWhen
}

export type ProductOnlySeam = { readonly runtime: string; readonly when: AdapterWhen; readonly reason: string }

/** Official ids that remain active after the shipped assistant Profile patch. */
export const OFFICIAL_RUNTIME_MOUNTS = Object.freeze([
  { official: 'dsh-assistant', runtime: 'dsh-assistant', when: 'always' },
  { official: 'agent', runtime: 'AgentRegistry', when: 'always' },
  { official: 'agent-default-model', runtime: 'AgentDefaultModelConfig', when: 'always' },
  { official: 'agent-loop', runtime: 'AgentLoop', when: 'always' },
  { official: 'session', runtime: 'SessionStore', when: 'always' },
  { official: 'llm', runtime: 'LlmRuntime', when: 'always' },
  { official: 'llm-deepseek', runtime: 'llm-deepseek', when: 'always' },
  { official: 'system-prompt', runtime: 'SystemPrompt', when: 'always' },
  { official: 'tools', runtime: 'ToolRuntime', when: 'always' },
  { official: 'skill', runtime: 'SkillRegistry', when: 'always' },
  { official: 'skill-filesystem', runtime: 'skill-filesystem', when: 'ready' },
  { official: 'tool-skill', runtime: 'tool-skill', when: 'ready' },
  { official: 'jobs', runtime: 'LocalJobRegistry', when: 'ready' },
  { official: 'session-persistence-jsonl', runtime: 'JsonlSessionPersistence', when: 'session-persistence' },
] as const satisfies readonly OfficialRuntimeMount[])

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
  { runtime: 'ApprovalService', when: 'ready', reason: 'DSH one-shot approval service' },
  { runtime: 'dsh-assistant-approval-bridge', when: 'ready', reason: 'unified DSH approval control surface' },
  { runtime: 'DshApprovalBridgeService', when: 'ready', reason: 'pending DSH approval broker' },
  { runtime: 'dsh-assistant-skills', when: 'always', reason: 'profile-scoped Skill lifecycle' },
] as const satisfies readonly ProductOnlySeam[])

export const PROTECTED_PLUGIN_IDS = Object.freeze(['dsh-assistant'] as const)

export interface ProfilePatchRow {
  readonly id?: string
  readonly disabled?: boolean | null
  readonly config?: unknown
}

function mappingApplies(when: AdapterWhen, options: { readonly safeMode?: boolean; readonly sessionPersistence?: boolean }): boolean {
  if (when === 'ready') return options.safeMode !== true
  if (when === 'session-persistence') return options.sessionPersistence === true
  return true
}

export function expectedProductionAdapterIds(
  activeOfficialIds: readonly string[],
  options: { readonly safeMode?: boolean; readonly sessionPersistence?: boolean } = {},
): readonly string[] {
  const active = new Set(activeOfficialIds)
  const ids = new Set<string>()
  for (const row of OFFICIAL_RUNTIME_MOUNTS) {
    if (!active.has(row.official)) continue
    if (mappingApplies(row.when, options)) ids.add(row.runtime)
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

export function assertOfficialMountContract(): void {
  const official = new Set<string>(ASSISTANT_OFFICIAL_COMPOSED_IDS)
  const mapped = new Set<string>()
  for (const row of OFFICIAL_RUNTIME_MOUNTS) {
    if (mapped.has(row.official)) {
      throw new RuntimeContextError(`official id ${row.official} is mapped twice`)
    }
    mapped.add(row.official)
    if (!official.has(row.official)) {
      throw new RuntimeContextError(`official mount contract contains unknown id ${row.official}`)
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

export function assertGovernedActiveComposition(entries: readonly ComposedProfileEntry[]): string[] {
  assertOfficialMountContract()
  const ids = entries.flatMap((row) => (typeof row.id === 'string' ? [row.id] : []))
  assertOfficialComposedIds(ids)
  const active = activeComposedIds(entries)
  const allowed = new Set<string>(OFFICIAL_RUNTIME_MOUNTS.map((row) => row.official))
  for (const id of active) {
    if (!allowed.has(id)) {
      throw new RuntimeContextError(`governed Profile left ${id} active without a production mount`)
    }
  }
  for (const row of OFFICIAL_RUNTIME_MOUNTS) {
    if (row.when === 'always' && !active.includes(row.official)) {
      throw new RuntimeContextError(`governed Profile disabled required official id ${row.official}`)
    }
  }
  return active
}

export function assertOfficialEquivalentToAdapter(
  composedIds: readonly string[],
  mountedIds: readonly string[],
  options: { readonly safeMode?: boolean; readonly sessionPersistence?: boolean } = {},
): void {
  const composition = loadGovernedAssistantComposition({ recovery: options.safeMode === true })
  assertOfficialComposedIds(composedIds)
  assertActiveProfileMatchesAdapter(composition, mountedIds, options)
}

export function assertActiveProfileMatchesAdapter(
  composition: GovernedProfileComposition,
  mountedIds: readonly string[],
  options: { readonly safeMode?: boolean; readonly sessionPersistence?: boolean } = {},
): void {
  assertAssistantBundles(composition.bundles)
  assertProfilePatchSafe(composition.patches)
  const active = assertGovernedActiveComposition(composition.entries)
  const expected = expectedProductionAdapterIds(active, options)
  const actual = [...new Set(mountedIds)].sort()
  if (actual.length !== expected.length || expected.some((id, index) => actual[index] !== id)) {
    throw new RuntimeContextError(`official composition is not equivalent to the production adapter: expected ${expected.join(',')} actual ${actual.join(',')}`)
  }
}

export function assertMountedAdapterContract(
  ctx: Context,
  options: { readonly safeMode?: boolean; readonly sessionPersistence?: boolean } = {},
): void {
  assertActiveProfileMatchesAdapter(loadGovernedAssistantComposition({ recovery: options.safeMode === true }), mountedAdapterPluginIds(ctx), options)
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
  const composition = loadGovernedAssistantComposition()
  assertAssistantBundles(composition.bundles)
  assertProfilePatchSafe(composition.patches)
  assertGovernedActiveComposition(composition.entries)
}

export function assertRecoveryAdapterContract(): void {
  const composition = loadGovernedAssistantComposition({ recovery: true })
  assertAssistantBundles(composition.bundles)
  assertProfilePatchSafe(composition.patches)
  assertGovernedActiveComposition(composition.entries)
}
