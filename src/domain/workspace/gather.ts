import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, isAppendSurfaceEvent, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { humorSuppressed } from '../personality/effective.js'
import type { TarsPersonality } from '../personality/types.js'
import { flattenEffects, summarizeCandidateEffects } from './effects.js'
import type { MissionControlView, ObjectiveView, WorkspaceSnapshotInput } from './types.js'
import { projectMissionControl } from './project.js'

export interface GatherWorkspaceInput {
  readonly ctx: Context
  readonly sessionId: string
  readonly objective?: ObjectiveView
}

/** Fold public runtime/session/governance/policy surfaces into a workspace snapshot. */
export function gatherWorkspaceSnapshot(input: GatherWorkspaceInput): WorkspaceSnapshotInput {
  const { ctx, sessionId } = input
  const personality = readPersonality(ctx)
  const agent = ctx.agents.get(SessionId(sessionId))
  const recovery = ctx.get('extensionRecovery') as {
    inspect(): {
      safeMode: boolean
      recoveryRequired?: boolean
      lastFailure?: { diagnostics: string }
    }
  } | undefined
  const activation = recovery?.inspect()
  const safeMode = Boolean(activation?.safeMode)
  const lastFailure = activation?.lastFailure?.diagnostics
  return {
    agentStatus: agent?.status,
    safeMode,
    recoveryRequired: Boolean(activation?.recoveryRequired),
    ...(lastFailure ? { recoveryWhy: lastFailure } : safeMode ? { recoveryWhy: 'Generated capabilities are disabled. Trusted core is available.' } : {}),
    pendingConfirmations: (ctx.get('actionPolicy') as { policy: { confirmations(): WorkspaceSnapshotInput['pendingConfirmations'] } } | undefined)
      ?.policy.confirmations() ?? [],
    jobs: (ctx.get('assistantJobs') as { service: { list(): { name: string; lastRun?: { status: string } }[] } } | undefined)
      ?.service.list().map((job) => ({ name: job.name, lastRunStatus: job.lastRun?.status })) ?? [],
    toolEvents: agent ? toolEventsFromSession(agent.session.events) : [],
    conversation: agent ? conversationWithoutReasoning(agent.session.events) : [],
    integrationStatus: Object.entries((ctx.get('integrations') as { hub: { status(): Record<string, { available: boolean; reason?: string }> } } | undefined)?.hub.status() ?? {})
      .map(([capability, availability]) => ({
        capability,
        available: availability.available,
        ...(availability.reason ? { reason: availability.reason } : {}),
      })),
    registry: (ctx.get('capabilityRegistry') as { list(): { owner: string; version: string; provenance: { kind: string }; status: string; capabilities: { id: string }[]; permissions?: readonly string[]; provider?: string; providers?: readonly string[] }[] } | undefined)
      ?.list().map((record) => ({
        owner: record.owner,
        version: record.version,
        provenance: record.provenance.kind,
        status: record.status,
        capabilities: record.capabilities.map((item) => item.id),
        ...(record.permissions ? { permissions: [...record.permissions] } : {}),
        ...(record.provider ? { provider: record.provider } : {}),
        ...(record.providers ? { providers: [...record.providers] } : {}),
      })) ?? [],
    extensionApprovals: extensionApprovals(ctx),
    candidates: workbenchCandidates(ctx),
    memory: (ctx.get('personalMemory') as { query(): { records: { id: string; statement: string; topicKey: string; status: string }[] } } | undefined)
      ?.query().records.map((record) => ({
        id: record.id,
        statement: record.statement,
        topicKey: record.topicKey,
        status: record.status,
        origin: 'personal-memory',
      })) ?? [],
    knowledge: (ctx.get('personalKnowledge') as { listDocuments(): { sourceUri: string; title?: string }[] } | undefined)
      ?.listDocuments().map((document) => ({
        sourceUri: document.sourceUri,
        ...(document.title ? { title: document.title } : {}),
      })) ?? [],
    ...(input.objective ? { objective: input.objective } : {}),
    personality: {
      humor: personality.humor,
      directness: personality.directness,
      initiative: personality.initiative,
      verbosity: personality.verbosity,
      humorSuppressed: personality.humorSuppressed,
    },
  }
}

export function projectWorkspace(input: GatherWorkspaceInput): MissionControlView {
  const snapshot = gatherWorkspaceSnapshot(input)
  const view = projectMissionControl(snapshot)
  const service = ctxPersonality(input.ctx)
  service?.setSituation({
    kind: view.systemState === 'SAFE_MODE' || view.systemState === 'RECOVERY' ? 'safety' : 'normal',
    systemState: view.systemState,
  })
  return view
}

function readPersonality(ctx: Context): WorkspaceSnapshotInput['personality'] {
  const service = ctxPersonality(ctx)
  const traits = service?.effective()
  const situation = service?.currentSituation() ?? { kind: 'normal' as const, systemState: 'READY' as const }
  return {
    humor: traits?.humor ?? 60,
    directness: traits?.directness ?? 85,
    initiative: traits?.initiative ?? 80,
    verbosity: traits?.verbosity ?? 'adaptive',
    humorSuppressed: humorSuppressed(situation),
  }
}

function ctxPersonality(ctx: Context): TarsPersonality | undefined {
  return ctx.get('tarsPersonality') as TarsPersonality | undefined
}

function visibleText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text' || block.type === 'tool-result')
    .map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'tool-result') return visibleText(block.content)
      return ''
    })
    .join('')
}

function conversationWithoutReasoning(events: readonly SessionEvent[]): WorkspaceSnapshotInput['conversation'] {
  const items: WorkspaceSnapshotInput['conversation'][number][] = []
  for (const event of events) {
    if (event.type === 'user/message' && isAppendSurfaceEvent(event)) {
      if (!isHumanUserMessage(event.data)) continue
      items.push({ kind: 'user', text: visibleText(event.data.content) })
    }
    if (event.type === 'assistant/message' && isAppendSurfaceEvent(event)) {
      items.push({ kind: 'assistant', text: visibleText(event.data.message.content) })
    }
    if (event.type === 'tool/call') {
      items.push({ kind: 'tool_call', text: event.data.name })
    }
    if (event.type === 'tool/result' && isAppendSurfaceEvent(event)) {
      items.push({ kind: 'tool_result', text: visibleText(event.data.message.content) })
    }
  }
  return items
}

function isHumanUserMessage(message: { readonly source: { readonly kind: string; readonly form?: string }; readonly content: readonly ContentBlock[] }): boolean {
  const source = message.source
  if (source.kind === 'plugin') return false
  if (source.form === 'snapshot' || source.form === 'instructions' || source.form === 'catalog') return false
  const text = visibleText(message.content)
  if (text.startsWith('Current runtime context')) return false
  return source.kind === 'user'
}

function toolEventsFromSession(events: readonly SessionEvent[]): WorkspaceSnapshotInput['toolEvents'] {
  const items: WorkspaceSnapshotInput['toolEvents'][number][] = []
  let lastCall: { name: string } | undefined
  for (const event of events) {
    if (event.type === 'tool/call') {
      lastCall = { name: event.data.name }
      items.push({ type: 'tool/call', name: event.data.name, text: event.data.arguments, seq: event.seq })
    }
    if (event.type === 'tool/result' && isAppendSurfaceEvent(event)) {
      items.push({
        type: 'tool/result',
        name: lastCall?.name,
        text: visibleText(event.data.message.content),
        isError: event.data.error !== undefined,
        seq: event.seq,
      })
    }
  }
  return items
}

function workbenchCandidates(ctx: Context): WorkspaceSnapshotInput['candidates'] {
  const workbench = ctx.get('candidateWorkbench') as { inspect(id: string): {
    id: string
    owner: string
    version: string
    baseVersion?: string
    lifecycle: string
    resolutionKind?: string
    resolutionCapability?: string
    sealed: boolean
    parentId?: string
    leftover?: boolean
    step?: string
    validation?: { passed: boolean; failed: readonly string[] }
    review?: { state: string; blockingFindings: number }
    diff?: import('./types.js').WorkbenchProjection['diff']
    requestEligibility: { ok: boolean; denials: readonly { reason: string }[] }
  } } | undefined
  const workspace = ctx.get('candidateWorkspace') as {
    list(): readonly {
      id: string
      owner: string
      version: string
      baseVersion?: string
      lifecycle: string
      sealed: boolean
      digest?: string
      manifest?: { resolutionKind?: string; resolutionCapability?: string }
      validation?: { passed: boolean; stages: { name: string; status: string }[] }
    }[]
    diff?(id: string): import('./types.js').WorkbenchProjection['diff']
  } | undefined
  if (!workspace) return []
  if (workbench) {
    return workspace.list().map((item) => {
      const view = workbench.inspect(item.id)
      const last = ctx.get('independentReview') as { lastReport(id: string): { findings: { claim: string; blocking: boolean; status: string }[] } | undefined } | undefined
      return {
        id: view.id,
        owner: view.owner,
        version: view.version,
        baseVersion: view.baseVersion,
        lifecycle: view.lifecycle,
        resolutionKind: view.resolutionKind,
        resolutionCapability: view.resolutionCapability,
        sealed: view.sealed,
        validationPassed: view.validation?.passed,
        validationFailed: view.validation?.failed,
        reviewState: view.review?.state,
        blockingFindings: view.review?.blockingFindings,
        blockerClaims: last?.lastReport(view.id)?.findings.filter((finding) => finding.blocking && finding.status === 'open').map((finding) => finding.claim),
        diff: view.diff,
        effectSummary: view.diff === undefined ? undefined : summarizeCandidateEffects(view.diff.effects),
        canRequestApproval: view.requestEligibility.ok,
        requestDenials: view.requestEligibility.denials.map((item) => item.reason),
        currentStep: view.step,
        validationFailureSummary: boundFailureSummary(view.validation?.failed),
        parentId: view.parentId,
        leftover: view.leftover,
        approvalState: approvalStateOf({
          canRequest: view.requestEligibility.ok,
          decision: (ctx.get('extensionGovernance') as { inspectApproval?(id: string): { decision: string } | undefined } | undefined)
            ?.inspectApproval?.(view.id)?.decision,
          owner: view.owner,
          version: view.version,
          registry: ctx.get('capabilityRegistry') as { get(owner: string, version: string): { status: string } | undefined } | undefined,
        }),
      }
    })
  }
  const review = ctx.get('independentReview') as { status(input: { id: string; digest?: string }): string; lastReport(id: string): { findings: { claim: string; blocking: boolean; status: string }[] } | undefined } | undefined
  const governance = ctx.get('extensionGovernance') as { requestEligibility(id: string): { ok: boolean; denials: readonly { reason: string }[] } } | undefined
  return workspace.list().map((record) => {
    const eligibility = governance?.requestEligibility(record.id)
    const last = review?.lastReport(record.id)
    const diff = workspace.diff?.(record.id)
    return {
      id: record.id,
      owner: record.owner,
      version: record.version,
      baseVersion: record.baseVersion,
      lifecycle: record.lifecycle,
      resolutionKind: record.manifest?.resolutionKind,
      resolutionCapability: record.manifest?.resolutionCapability,
      sealed: record.sealed,
      validationPassed: record.validation?.passed,
      validationFailed: record.validation?.stages.filter((item) => item.status === 'failed' || item.status === 'blocked').map((item) => item.name),
      reviewState: review?.status({ id: record.id, digest: record.digest }),
      blockingFindings: last?.findings.filter((item) => item.blocking && item.status === 'open').length,
      blockerClaims: last?.findings.filter((item) => item.blocking && item.status === 'open').map((item) => item.claim),
      diff,
      effectSummary: diff === undefined ? undefined : summarizeCandidateEffects(diff.effects),
      canRequestApproval: eligibility?.ok === true,
      requestDenials: eligibility?.denials.map((item) => item.reason),
    }
  })
}

function extensionApprovals(ctx: Context): WorkspaceSnapshotInput['extensionApprovals'] {
  const governance = ctx.get('extensionGovernance') as {
    inspectApproval?(id: string): unknown
    inspectSummary?(id: string): {
      owner: string
      candidateVersion: string
      digest: string
      capabilities: { added: readonly string[]; removed: readonly string[] }
      permissions: { added: readonly string[]; removed: readonly string[] }
      secrets: readonly string[]
      effects: { filesystem: readonly string[]; network: readonly string[]; process: readonly string[]; secrets: readonly string[]; externalSystems: readonly string[] }
    }
  } | undefined
  const workspace = ctx.get('candidateWorkspace') as { list(): { id: string }[] } | undefined
  if (!governance?.inspectApproval || !workspace) return []
  const out: Array<{
    readonly id: string
    readonly candidateId: string
    readonly fingerprint: string
    readonly decision: string
    readonly owner: string
    readonly candidateVersion: string
    readonly digest: string
    readonly capabilitiesAdded: readonly string[]
    readonly capabilitiesRemoved: readonly string[]
    readonly permissionsAdded: readonly string[]
    readonly permissionsRemoved: readonly string[]
    readonly effects: readonly string[]
  }> = []
  for (const candidate of workspace.list()) {
    const record = governance.inspectApproval(candidate.id) as { id: string; fingerprint: string; decision: string } | undefined
    if (!record) continue
    const summary = governance.inspectSummary?.(candidate.id)
    if (!summary) continue
    out.push({
      id: record.id,
      candidateId: candidate.id,
      fingerprint: record.fingerprint,
      decision: record.decision,
      owner: summary.owner,
      candidateVersion: summary.candidateVersion,
      digest: summary.digest,
      capabilitiesAdded: [...(summary.capabilities.added ?? [])],
      capabilitiesRemoved: [...(summary.capabilities.removed ?? [])],
      permissionsAdded: [...(summary.permissions.added ?? [])],
      permissionsRemoved: [...(summary.permissions.removed ?? [])],
      effects: flattenEffects(summary.effects, summary.secrets ?? []),
    })
  }
  return out
}

function boundFailureSummary(failed?: readonly string[]): string | undefined {
  if (!failed?.length) return undefined
  const text = failed.join(', ')
  return text.length > 160 ? `${text.slice(0, 148)}[truncated]` : text
}

function approvalStateOf(input: {
  readonly canRequest: boolean
  readonly decision?: string
  readonly owner: string
  readonly version: string
  readonly registry?: { get(owner: string, version: string): { status: string } | undefined }
}): import('./types.js').WorkbenchProjection['approvalState'] {
  if (input.registry?.get(input.owner, input.version)?.status === 'active') return 'active'
  if (input.decision === 'approved-for-exact-diff') return 'approved'
  if (input.decision === 'approval-requested') return 'approval-requested'
  if (input.canRequest) return 'ready-for-approval'
  return 'not-ready'
}
