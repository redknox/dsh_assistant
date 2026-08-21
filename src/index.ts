export { apply, inject, name, PRODUCT_TOOL_NAMES, type AssistantBundleConfig } from './product/bundle.js'

export { bootAssistantRuntime, createAssistantAgent } from './runtime/boot.js'
export { ASSISTANT_PERSONA } from './product/persona.js'
export { JsonFileMemoryPersistence } from './adapters/memory/json-file-persistence.js'
export { ingestLocalTextFile } from './adapters/knowledge/local-file-ingest.js'
export * from './domain/memory/index.js'
export * from './domain/knowledge/index.js'
export * from './domain/integrations/index.js'
export * from './domain/policy/index.js'
export * from './domain/jobs/index.js'
export * from './domain/registry/index.js'
export * from './domain/resolution/index.js'
export * from './domain/candidate/index.js'
export { FakeClock, IntervalScheduler } from './adapters/jobs/interval-scheduler.js'
export {
  AssistantControlSurface,
  projectAssistantView,
  renderAssistantViewAsHtml,
  renderAssistantViewAsText,
} from './ui/index.js'
export type {
  AssistantView,
  CapabilityStatusDto,
  ConfirmationDto,
  ConversationItemDto,
  JobViewDto,
  KnowledgeHitDto,
  KnowledgeSourceDto,
  MemoryEntryDto,
} from './ui/index.js'
export { FakeIntegrationSuite } from './adapters/integrations/fake-providers.js'
export { FakeReplyAdapter } from './adapters/llm/fake-reply-adapter.js'
export { PLAN_MY_DAY_FOCUS, PlanMyDayAdapter } from './adapters/llm/plan-my-day-adapter.js'
