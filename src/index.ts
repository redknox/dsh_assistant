import type { Context } from '@deepseek-ai/cordis'
import * as assistantPlugin from './plugins/assistant-plugin.js'
import * as integrationsPlugin from './plugins/integrations-plugin.js'
import * as knowledgePlugin from './plugins/knowledge-plugin.js'
import * as memoryPlugin from './plugins/memory-plugin.js'
import * as jobsPlugin from './plugins/jobs-plugin.js'
import * as policyPlugin from './plugins/policy-plugin.js'

export const name = 'dsh-assistant'
export const inject = ['systemPrompt', 'agents']

/** Bundle entry: compose product plugins through public Cordis lifecycle. */
export function apply(ctx: Context) {
  ctx.plugin(memoryPlugin)
  ctx.plugin(knowledgePlugin)
  ctx.plugin(integrationsPlugin)
  ctx.plugin(policyPlugin)
  ctx.plugin(jobsPlugin)
  ctx.plugin(assistantPlugin)
}

export { bootAssistantRuntime, createAssistantAgent } from './runtime/boot.js'
export { ASSISTANT_PERSONA } from './product/persona.js'
export { JsonFileMemoryPersistence } from './adapters/memory/json-file-persistence.js'
export { ingestLocalTextFile } from './adapters/knowledge/local-file-ingest.js'
export * from './domain/memory/index.js'
export * from './domain/knowledge/index.js'
export * from './domain/integrations/index.js'
export * from './domain/policy/index.js'
export * from './domain/jobs/index.js'
export { FakeClock, IntervalScheduler } from './adapters/jobs/interval-scheduler.js'
export { FakeIntegrationSuite } from './adapters/integrations/fake-providers.js'
