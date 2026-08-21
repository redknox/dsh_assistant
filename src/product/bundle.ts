import type { Context } from '@deepseek-ai/cordis'
import * as assistantPlugin from '../plugins/assistant-plugin.js'
import * as integrationsPlugin from '../plugins/integrations-plugin.js'
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
import * as reviewPlugin from '../plugins/review-plugin.js'
import type { ReviewPluginConfig } from '../plugins/review-plugin.js'
import * as governancePlugin from '../plugins/governance-plugin.js'
import type { GovernancePluginConfig } from '../plugins/governance-plugin.js'

export const name = 'dsh-assistant'
export const inject = ['systemPrompt', 'agents']

/** Product-bundle config. Secrets never belong here; pass local paths only. */
export interface AssistantBundleConfig {
  readonly registry?: RegistryPluginConfig
  readonly candidate?: CandidatePluginConfig
  readonly review?: ReviewPluginConfig
  readonly memory?: MemoryPluginConfig
  readonly knowledge?: KnowledgePluginConfig
  readonly policy?: PolicyPluginConfig
  readonly jobs?: JobsPluginConfig
  /** When true, skip optional/generated product plugins and boot the recovery core only. */
  readonly safeMode?: boolean
  readonly governance?: GovernancePluginConfig
}

/** Bundle entry: compose product plugins through public Cordis lifecycle. */
export async function apply(ctx: Context, config: AssistantBundleConfig = {}) {
  await ctx.plugin(registryPlugin, config.registry)
  await ctx.plugin(resolutionPlugin)
  await ctx.plugin(candidatePlugin, config.candidate)
  await ctx.plugin(reviewPlugin, config.review)
  await ctx.plugin(governancePlugin, config.governance)
  if (config.safeMode) return
  await ctx.plugin(memoryPlugin, config.memory)
  await ctx.plugin(knowledgePlugin, config.knowledge)
  await ctx.plugin(integrationsPlugin)
  await ctx.plugin(policyPlugin, config.policy)
  await ctx.plugin(jobsPlugin, config.jobs)
  await ctx.plugin(assistantPlugin)
}

export const SAFE_MODE_TOOL_NAMES = [
  'list_capabilities',
  'lookup_capability',
  'review_capability_resolution',
  'inspect_extension_governance',
  'request_extension_approval',
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
  'tasks_propose_create',
  'integration_status',
  'calendar_create_event',
  'tasks_create',
  'files_delete',
  'confirm_action',
] as const
