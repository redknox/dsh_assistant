import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { KnowledgeRetrieval } from '../domain/knowledge/types.js'
import type { MemoryCategory, MemoryReplaceInput, MemoryWriteInput, Provenance } from '../domain/memory/types.js'
import type { PolicyOutcome } from '../domain/policy/types.js'
import type { ApprovalCard, MissionControlView, ObjectiveView } from '../domain/workspace/types.js'
import { publicRuntimeContextView, type RuntimeContext } from '../product/runtime-context.js'
import { projectWorkspace } from '../domain/workspace/gather.js'
import type { UserPersonalityPrefs } from '../domain/personality/types.js'
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
 * A control-plane decision is not a human conversation message.
 */
export class AssistantControlSurface {
  private retrieval?: KnowledgeRetrieval
  private objective?: ObjectiveView
  private currentSessionId: string

  constructor(
    private readonly ctx: Context,
    sessionId: string,
    readonly runtimeContext?: RuntimeContext,
    private readonly sessionCatalog?: {
      inspect(): MissionControlView['sessions']
      approvalOrigins(): Readonly<Record<string, string>>
      noteApprovalOrigin?(confirmationId: string, sessionId: string): void
    },
  ) {
    this.currentSessionId = sessionId
  }

  get sessionId(): string {
    return this.currentSessionId
  }

  setSessionId(sessionId: string): void {
    this.currentSessionId = sessionId
  }

  snapshot(): AssistantView {
    return projectAssistantView({
      ctx: this.ctx,
      sessionId: this.sessionId,
      lastRetrieval: this.retrieval,
    })
  }

  workspace() {
    const runtimeContext = this.runtimeContext
      ? {
        ...publicRuntimeContextView(this.runtimeContext),
        sessionId: this.currentSessionId,
      }
      : undefined
    return projectWorkspace({
      ctx: this.ctx,
      sessionId: this.sessionId,
      ...(this.objective ? { objective: this.objective } : {}),
      ...(runtimeContext ? { runtimeContext } : {}),
      ...(this.sessionCatalog ? {
        sessions: this.sessionCatalog.inspect(),
        approvalOrigins: this.sessionCatalog.approvalOrigins(),
      } : {}),
    })
  }

  setObjective(text: string) {
    this.objective = { text, status: 'active' }
    return this.workspace()
  }

  setPersonality(prefs: UserPersonalityPrefs) {
    const preview = this.ctx.tarsPersonality.preview(prefs)
    this.ctx.tarsPersonality.setUserPrefs(prefs)
    return preview
  }

  sendMessage(text: string): void {
    const agent = this.requireAgent()
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    agent.followup(message)
  }

  async approve(confirmationId: string): Promise<PolicyOutcome> {
    return this.ctx.actionPolicy.policy.resolve(confirmationId, 'approve')
  }

  async deny(confirmationId: string): Promise<PolicyOutcome> {
    return this.ctx.actionPolicy.policy.resolve(confirmationId, 'deny')
  }

  async cancelConfirmation(confirmationId: string): Promise<PolicyOutcome> {
    return this.ctx.actionPolicy.policy.resolve(confirmationId, 'cancel')
  }

  /** Route one bound UI decision to its owning approval system. */
  async resolveApproval(card: ApprovalCard, decision: 'approve' | 'deny' | 'cancel'): Promise<unknown> {
    if (card.kind === 'dsh-tool') {
      const bridge = this.ctx.get('dshApprovalBridge') as {
        broker: { resolve(id: string, decision: 'approve' | 'deny' | 'cancel'): unknown }
      } | undefined
      if (!bridge) throw new Error('DSH approval bridge is unavailable')
      return bridge.broker.resolve(card.id, decision)
    }
    if (decision === 'approve') return this.approve(card.id)
    if (decision === 'deny') return this.deny(card.id)
    return this.cancelConfirmation(card.id)
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
    const outcome = this.ctx.actionPolicy.policy.decide({
      capability,
      operation,
      intent: 'execute',
      payload,
    })
    if (outcome.kind === 'pending_confirmation') {
      this.sessionCatalog?.noteApprovalOrigin?.(outcome.confirmationId, this.sessionId)
    }
    return outcome
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
