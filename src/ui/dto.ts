/**
 * UI-facing DTOs. These are a projection boundary, not domain contracts.
 * Frontends must not import memory/knowledge/policy/job types for view state.
 */

export type ConversationKind = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'queued'

export interface ConversationItemDto {
  readonly kind: ConversationKind
  readonly id: string
  readonly time?: number
  readonly text: string
  readonly toolName?: string
  readonly callId?: string
}

export interface ConfirmationDto {
  readonly id: string
  readonly fingerprint: string
  readonly capability: string
  readonly operation: string
  readonly payload: Record<string, unknown>
  readonly level: string
  readonly status: string
}

export interface MemoryEntryDto {
  readonly id: string
  readonly category: string
  readonly topicKey: string
  readonly statement: string
  readonly polarity: string
  readonly status: string
  readonly visibility: string
  readonly updatedAt: string
}

export interface KnowledgeSourceDto {
  readonly documentId: string
  readonly sourceUri: string
  readonly sourceKind: string
  readonly title?: string
}

export interface KnowledgeHitDto {
  readonly documentId: string
  readonly chunkId: string
  readonly sourceUri: string
  readonly excerpt: string
  readonly title?: string
  readonly why: readonly string[]
}

export interface JobViewDto {
  readonly name: string
  readonly title: string
  readonly schedule: string
  readonly lastRunId?: string
  readonly lastRunStatus?: string
  readonly lastRunSummary?: string
}

export interface CapabilityStatusDto {
  readonly capability: string
  readonly available: boolean
  readonly reason?: string
}

export interface AssistantView {
  readonly sessionId: string
  readonly agentStatus?: 'idle' | 'running'
  readonly conversation: readonly ConversationItemDto[]
  readonly jobs: readonly JobViewDto[]
  readonly confirmations: readonly ConfirmationDto[]
  readonly memory: readonly MemoryEntryDto[]
  readonly knowledgeSources: readonly KnowledgeSourceDto[]
  readonly knowledgeHits: readonly KnowledgeHitDto[]
  readonly knowledgeTrace?: string
  readonly capabilities: readonly CapabilityStatusDto[]
}
