import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { KnowledgeRetrieval } from '../domain/knowledge/types.js'
import type { MemoryCategory, MemoryReplaceInput, MemoryWriteInput, Provenance } from '../domain/memory/types.js'
import type { PolicyOutcome } from '../domain/policy/types.js'
import type { AssistantView, KnowledgeSourceDto } from './dto.js'
import { projectAssistantView } from './projection.js'

export interface RememberInput {
  readonly category: MemoryCategory
  readonly topicKey: string
  readonly statement: string
}

export interface EditMemoryInput {
  readonly id: string
  readonly statement: string
}

/**
 * Product control surface. Actions call public DSH/application services.
 * No policy, memory, or integration rules live here.
 */
export class AssistantControlSurface {
  private retrieval?: KnowledgeRetrieval

  constructor(
    private readonly ctx: Context,
    readonly sessionId: string,
  ) {}

  snapshot(): AssistantView {
    return projectAssistantView({
      ctx: this.ctx,
      sessionId: this.sessionId,
      lastRetrieval: this.retrieval,
    })
  }

  sendMessage(text: string): void {
    const agent = this.requireAgent()
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    agent.followup(message)
  }

  approve(confirmationId: string): Promise<PolicyOutcome> {
    return this.ctx.actionPolicy.policy.resolve(confirmationId, 'approve')
  }

  deny(confirmationId: string): Promise<PolicyOutcome> {
    return this.ctx.actionPolicy.policy.resolve(confirmationId, 'deny')
  }

  cancelConfirmation(confirmationId: string): Promise<PolicyOutcome> {
    return this.ctx.actionPolicy.policy.resolve(confirmationId, 'cancel')
  }

  startJob(name: string, input: Record<string, unknown> = {}) {
    return this.ctx.assistantJobs.service.start(name, input)
  }

  cancelJob(runId: string) {
    return this.ctx.assistantJobs.service.cancel(runId)
  }

  waitJob(runId: string, timeoutMs = 5000) {
    return this.ctx.assistantJobs.service.wait(runId, timeoutMs)
  }

  cancelAgentWork(): void {
    this.requireAgent().cancel({ kind: 'user' })
  }

  remember(input: RememberInput) {
    const write: MemoryWriteInput = {
      category: input.category,
      topicKey: input.topicKey,
      statement: input.statement,
      polarity: 'true',
      confidence: { kind: 'unknown' },
      provenance: userProvenance(),
      visibility: 'model',
      conflictPolicy: 'keep_both',
    }
    return this.ctx.personalMemory.write(write)
  }

  editMemory(input: EditMemoryInput) {
    const replace: MemoryReplaceInput = {
      statement: input.statement,
      provenance: userProvenance(),
    }
    return this.ctx.personalMemory.replace(input.id, replace)
  }

  forgetMemory(id: string) {
    return this.ctx.personalMemory.delete(id, userProvenance())
  }

  retrieveKnowledge(query: string) {
    this.retrieval = this.ctx.personalKnowledge.retrieve({ text: query })
    return this.retrieval
  }

  inspectSource(documentId: string): KnowledgeSourceDto | undefined {
    const document = this.ctx.personalKnowledge.getDocument(documentId)
    if (!document) return undefined
    return {
      documentId: document.id,
      sourceUri: document.sourceUri,
      sourceKind: document.sourceKind,
      ...(document.title ? { title: document.title } : {}),
    }
  }

  requestExecute(capability: string, operation: string, payload: Record<string, unknown>) {
    return this.ctx.actionPolicy.policy.decide({
      capability,
      operation,
      intent: 'execute',
      payload,
    })
  }

  private requireAgent() {
    const agent = this.ctx.agents.get(SessionId(this.sessionId))
    if (!agent) throw new Error(`no live agent for session ${this.sessionId}`)
    return agent
  }
}

function userProvenance(): Provenance {
  return {
    actor: 'user',
    mechanism: 'explicit_write',
    evidenceIds: ['ui:control-surface'],
    recordedAt: new Date().toISOString(),
  }
}
