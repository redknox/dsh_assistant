import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, isAppendSurfaceEvent, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ConfirmationTicket } from '../domain/policy/types.js'
import type { KnowledgeDocument, KnowledgeHit, KnowledgeRetrieval } from '../domain/knowledge/types.js'
import type { WorkflowSchedule, WorkflowStatus } from '../domain/jobs/types.js'
import type { MemoryRecord } from '../domain/memory/types.js'
import type {
  AssistantView,
  CapabilityStatusDto,
  ConfirmationDto,
  ConversationItemDto,
  JobViewDto,
  KnowledgeHitDto,
  KnowledgeSourceDto,
  MemoryEntryDto,
} from './dto.js'

export interface ProjectionInput {
  readonly ctx: Context
  readonly sessionId: string
  readonly lastRetrieval?: KnowledgeRetrieval
}

/** Fold public session/agent/service surfaces into a UI view-model. */
export function projectAssistantView(input: ProjectionInput): AssistantView {
  const { ctx, sessionId } = input
  const agent = ctx.agents.get(SessionId(sessionId))
  return {
    sessionId,
    ...(agent ? { agentStatus: agent.status } : {}),
    conversation: agent
      ? projectConversationFromEvents(
        agent.session.events,
        [...agent.inbox.nextTurn, ...agent.inbox.nextStep].map((message) => ({
          id: String(message.id),
          text: blocksText(message.content),
        })),
      )
      : [],
    jobs: ctx.assistantJobs.service.list().map(toJobView),
    confirmations: ctx.actionPolicy.policy.confirmations().map(toConfirmation),
    memory: ctx.personalMemory.query({ includeDeleted: true, includeSuperseded: true, visibility: 'any' }).records.map(toMemory),
    knowledgeSources: ctx.personalKnowledge.listDocuments().map(toSource),
    knowledgeHits: (input.lastRetrieval?.hits ?? []).map(toHit),
    ...(input.lastRetrieval ? { knowledgeTrace: input.lastRetrieval.trace.why } : {}),
    capabilities: toCapabilities(ctx),
  }
}

export function projectConversationFromEvents(
  events: readonly SessionEvent[],
  queued: readonly { id: string; text: string }[] = [],
): ConversationItemDto[] {
  const items: ConversationItemDto[] = []
  for (const event of events) {
    if (event.type === 'user/message' && isAppendSurfaceEvent(event)) {
      items.push({
        kind: 'user',
        id: `seq-${event.seq}`,
        time: event.time,
        text: blocksText(event.data.content),
      })
      continue
    }
    if (event.type === 'assistant/message' && isAppendSurfaceEvent(event)) {
      items.push({
        kind: 'assistant',
        id: `seq-${event.seq}`,
        time: event.time,
        text: blocksText(event.data.message.content),
      })
      continue
    }
    if (event.type === 'tool/call') {
      items.push({
        kind: 'tool_call',
        id: `seq-${event.seq}`,
        time: event.time,
        text: event.data.arguments,
        toolName: event.data.name,
        callId: String(event.data.callId),
      })
      continue
    }
    if (event.type === 'tool/result' && isAppendSurfaceEvent(event)) {
      items.push({
        kind: 'tool_result',
        id: `seq-${event.seq}`,
        time: event.time,
        text: blocksText(event.data.message.content),
        callId: String(event.data.message.source.callId),
      })
    }
  }
  for (const message of queued) {
    items.push({
      kind: 'queued',
      id: message.id,
      text: message.text,
    })
  }
  return items
}

function blocksText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'reasoning') parts.push(block.text)
    else if (block.type === 'tool-result') parts.push(blocksText(block.content))
  }
  return parts.join('')
}

function toConfirmation(ticket: ConfirmationTicket): ConfirmationDto {
  return {
    id: ticket.id,
    fingerprint: ticket.fingerprint,
    capability: ticket.capability,
    operation: ticket.operation,
    payload: { ...ticket.payload },
    level: ticket.level,
    status: ticket.status,
  }
}

function toMemory(record: MemoryRecord): MemoryEntryDto {
  return {
    id: record.id,
    category: record.category,
    topicKey: record.topicKey,
    statement: record.statement,
    polarity: record.polarity,
    status: record.status,
    visibility: record.visibility,
    updatedAt: record.updatedAt,
  }
}

function toSource(document: KnowledgeDocument): KnowledgeSourceDto {
  return {
    documentId: document.id,
    sourceUri: document.sourceUri,
    sourceKind: document.sourceKind,
    ...(document.title ? { title: document.title } : {}),
  }
}

function toHit(hit: KnowledgeHit): KnowledgeHitDto {
  return {
    documentId: hit.citation.documentId,
    chunkId: hit.citation.chunkId,
    sourceUri: hit.citation.sourceUri,
    excerpt: hit.citation.excerpt,
    why: [...hit.reasons],
    ...(hit.citation.title ? { title: hit.citation.title } : {}),
  }
}

function toJobView(status: WorkflowStatus): JobViewDto {
  return {
    name: status.name,
    title: status.title,
    schedule: formatSchedule(status.schedule),
    ...(status.lastRun
      ? {
          lastRunId: status.lastRun.runId,
          lastRunStatus: status.lastRun.status,
          ...(status.lastRun.summary ? { lastRunSummary: status.lastRun.summary } : {}),
        }
      : {}),
  }
}

function formatSchedule(schedule: WorkflowSchedule): string {
  return schedule.kind === 'every' ? `every ${schedule.everyMs}ms` : 'manual'
}

function toCapabilities(ctx: Context): CapabilityStatusDto[] {
  return Object.entries(ctx.integrations.hub.status()).map(([capability, availability]) => ({
    capability,
    available: availability.available,
    ...(availability.reason ? { reason: availability.reason } : {}),
  }))
}
