import type { Context } from '@deepseek-ai/cordis'
import * as assistantPlugin from '../plugins/assistant-plugin.js'
import * as integrationsPlugin from '../plugins/integrations-plugin.js'
import type { IntegrationsPluginConfig } from '../plugins/integrations-plugin.js'
import * as jobsPlugin from '../plugins/jobs-plugin.js'
import type { JobsPluginConfig } from '../plugins/jobs-plugin.js'
import * as knowledgePlugin from '../plugins/knowledge-plugin.js'
import type { KnowledgePluginConfig } from '../plugins/knowledge-plugin.js'
import * as memoryPlugin from '../plugins/memory-plugin.js'
import type { MemoryPluginConfig } from '../plugins/memory-plugin.js'
import * as policyPlugin from '../plugins/policy-plugin.js'
import type { PolicyPluginConfig } from '../plugins/policy-plugin.js'
import * as registryPlugin from '../plugins/registry-plugin.js'
import type { RegistryPluginConfig } from '../plugins/registry-plugin.js'
import * as resolutionPlugin from '../plugins/resolution-plugin.js'
import * as candidatePlugin from '../plugins/candidate-plugin.js'
import type { CandidatePluginConfig } from '../plugins/candidate-plugin.js'
import * as personalityPlugin from '../plugins/personality-plugin.js'
import type { PersonalityPluginConfig } from '../plugins/personality-plugin.js'
import * as reviewPlugin from '../plugins/review-plugin.js'
import type { ReviewPluginConfig } from '../plugins/review-plugin.js'
import * as governancePlugin from '../plugins/governance-plugin.js'
import type { GovernancePluginConfig } from '../plugins/governance-plugin.js'
import * as workbenchPlugin from '../plugins/workbench-plugin.js'
import type { WorkbenchPluginConfig } from '../plugins/workbench-plugin.js'
import * as skillPlugin from '../plugins/skill-plugin.js'
import type { SkillPluginConfig } from '../plugins/skill-plugin.js'

export const name = 'dsh-assistant'
export const inject = ['systemPrompt', 'agents']

/** Product-bundle config. Secrets never belong here; pass local paths only. */
export interface AssistantBundleConfig {
  readonly registry?: RegistryPluginConfig
  readonly candidate?: CandidatePluginConfig
  readonly review?: ReviewPluginConfig
  readonly personality?: PersonalityPluginConfig
  readonly memory?: MemoryPluginConfig
  readonly knowledge?: KnowledgePluginConfig
  readonly integrations?: IntegrationsPluginConfig
  readonly policy?: PolicyPluginConfig
  readonly jobs?: JobsPluginConfig
  /** When true, skip optional/generated product plugins and boot the recovery core only. */
  readonly safeMode?: boolean
  readonly governance?: GovernancePluginConfig
  readonly workbench?: WorkbenchPluginConfig
  readonly skills?: SkillPluginConfig
}

/** Bundle entry: compose product plugins through public Cordis lifecycle. */
export async function apply(ctx: Context, config: AssistantBundleConfig = {}) {
  await ctx.plugin(registryPlugin, config.registry)
  await ctx.plugin(resolutionPlugin)
  await ctx.plugin(candidatePlugin, config.candidate)
  await ctx.plugin(reviewPlugin, config.review)
  await ctx.plugin(personalityPlugin, config.personality)
  await ctx.plugin(governancePlugin, {
    ...config.governance,
    allowRequestTool: config.safeMode !== true,
  })
  await ctx.plugin(workbenchPlugin, {
    ...config.workbench,
    inspectOnly: config.safeMode === true,
  })
  await ctx.plugin(skillPlugin, {
    ...config.skills,
    inspectOnly: config.safeMode === true,
  })
  if (config.safeMode) return
  await ctx.plugin(memoryPlugin, config.memory)
  await ctx.plugin(knowledgePlugin, config.knowledge)
  await ctx.plugin(integrationsPlugin, config.integrations)
  await ctx.plugin(policyPlugin, config.policy)
  await ctx.plugin(jobsPlugin, config.jobs)
  await ctx.plugin(assistantPlugin)
}

export const SAFE_MODE_TOOL_NAMES = [
  'list_capabilities',
  'lookup_capability',
  'review_capability_resolution',
  'inspect_extension_governance',
  'inspect_authoring_contract',
  'list_workbench',
  'inspect_candidate',
  'inspect_candidate_review',
  'inspect_validation_diagnostics',
  'inspect_skill',
] as const

export const PRODUCT_TOOL_NAMES = [
  'list_capabilities',
  'lookup_capability',
  'review_capability_resolution',
  'inspect_extension_governance',
  'request_extension_approval',
  'remember_memory',
  'forget_memory',
  'recall_memory',
  'retrieve_knowledge',
  'calendar_list_events',
  'calendar_get_event',
  'calendar_freebusy',
  'calendar_propose_event',
  'mail_list_messages',
  'mail_get_message',
  'contacts_search',
  'tasks_propose_create',
  'files_list',
  'files_read',
  'integration_status',
  'calendar_create_event',
  'tasks_create',
  'files_write',
  'files_delete',
  'confirm_action',
  'plan_capability_change',
  'create_candidate',
  'scaffold_candidate',
  'inspect_authoring_contract',
  'inspect_candidate',
  'inspect_validation_diagnostics',
  'list_workbench',
  'list_candidate_files',
  'read_candidate_file',
  'write_candidate_file',
  'set_candidate_manifest',
  'validate_candidate',
  'seal_candidate',
  'review_candidate',
  'inspect_candidate_review',
  'repair_candidate',
] as const
