import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, isAppendSurfaceEvent, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { humorSuppressed } from '../personality/effective.js'
import type { TarsPersonality } from '../personality/types.js'
import { flattenEffects, summarizeCandidateEffects } from './effects.js'
import { boundActivationDiagnostics } from './failure.js'
import { activationViewOf, approvalStateOf, compareOwnerVersion, extensionLifecycleOf } from './lifecycle.js'
import type { ExecutionLogEntry, MissionControlView, ObjectiveView, WorkspaceSnapshotInput } from './types.js'
import { projectMissionControl } from './project.js'
import { inspectContextEndurance } from '../../product/context-endurance.js'
import { inspectMaterialInput } from '../../product/material-input.js'

export interface GatherWorkspaceInput {
  readonly ctx: Context
  readonly sessionId: string
  readonly objective?: ObjectiveView
  readonly runtimeContext?: MissionControlView['runtimeContext']
  readonly sessions?: MissionControlView['sessions']
  readonly approvalOrigins?: Readonly<Record<string, string>>
}

/** Fold public runtime/session/governance/policy surfaces into a workspace snapshot. */
export function gatherWorkspaceSnapshot(input: GatherWorkspaceInput): WorkspaceSnapshotInput {
  const { ctx, sessionId } = input
  const personality = readPersonality(ctx)
  const agent = ctx.agents.get(SessionId(sessionId))
  const contextEndurance = inspectContextEndurance(ctx, agent?.session)
  const materialInput = inspectMaterialInput(ctx)
  const actionPolicy = ctx.get('actionPolicy') as {
    policy: {
      confirmations(): WorkspaceSnapshotInput['pendingConfirmations']
      autoExecuteCapabilities(): readonly string[]
    }
  } | undefined
  const recovery = ctx.get('extensionRecovery') as {
    inspect(): {
      safeMode: boolean
      recoveryRequired?: boolean
      state?: string
      pendingCandidateId?: string
      lifecycleBusy?: 'activation' | 'uninstall' | 'disable' | 'recovery'
      lastFailure?: {
        diagnostics: string
        candidateId?: string
        phase?: string
        rollbackSucceeded?: boolean
        safeModeRequired?: boolean
      }
      current?: { generation: number; mounted: readonly string[]; owners: readonly { owner: string; version: string; status: string; capabilities: readonly string[] }[] }
      rollbackTarget?: { generation: number; mounted: readonly string[]; owners: readonly { owner: string; version: string; status: string; capabilities: readonly string[] }[] }
      lastKnownGood?: { generation: number; mounted: readonly string[]; owners: readonly { owner: string; version: string; status: string; capabilities: readonly string[] }[] }
      rollbackPlan?: {
        id: string
        currentGeneration: number
        targetGeneration: number
        fingerprint: string
        available: boolean
        denials: readonly { reason: string; detail: string }[]
      }
    }
  } | undefined
  const activation = recovery?.inspect()
  const safeMode = Boolean(activation?.safeMode) || Boolean(input.runtimeContext?.safeMode)
  const lastFailure = activation?.lastFailure
  const boundedFailure = lastFailure?.diagnostics ? boundActivationDiagnostics(lastFailure.diagnostics) : undefined
  const runtimeContext = input.runtimeContext
    ? {
      ...input.runtimeContext,
      safeMode,
      sessionPersistence: safeMode || Boolean(activation?.recoveryRequired)
        ? 'recovery-required' as const
        : input.runtimeContext.sessionPersistence,
    }
    : undefined
  return {
    agentStatus: agent?.status,
    safeMode,
    recoveryRequired: Boolean(activation?.recoveryRequired),
    ...(activation?.recoveryRequired && boundedFailure
      ? { recoveryWhy: boundedFailure }
      : safeMode
        ? { recoveryWhy: 'Generated capabilities are disabled. Trusted core is available.' }
        : {}),
    pendingConfirmations: actionPolicy?.policy.confirmations() ?? [],
    dshApprovals: (ctx.get('dshApprovalBridge') as {
      broker: { list(): WorkspaceSnapshotInput['dshApprovals'] }
    } | undefined)?.broker.list() ?? [],
    autoExecuteCapabilities: actionPolicy?.policy.autoExecuteCapabilities() ?? [],
    jobs: (ctx.get('assistantJobs') as { service: { list(): { name: string; lastRun?: { status: string } }[] } } | undefined)
      ?.service.list().map((job) => ({ name: job.name, lastRunStatus: job.lastRun?.status })) ?? [],
    toolEvents: agent ? toolEventsFromSession(agent.session.events) : [],
    conversation: agent ? conversationWithoutReasoning(agent.session.events) : [],
    executionLog: agent ? executionLogFromSession(agent.session.events) : [],
    integrationStatus: Object.entries((ctx.get('integrations') as { hub: { status(): Record<string, { available: boolean; configured?: boolean; reason?: string; provider?: string }> } } | undefined)?.hub.status() ?? {})
      .map(([capability, availability]) => ({
        capability,
        available: availability.available,
        ...(availability.configured !== undefined ? { configured: availability.configured } : {}),
        ...(availability.reason ? { reason: availability.reason } : {}),
        ...(availability.provider ? { provider: availability.provider } : {}),
      })),
    registry: (ctx.get('capabilityRegistry') as { list(): { owner: string; version: string; provenance: { kind: string }; status: string; capabilities: { id: string }[]; permissions?: readonly string[]; provider?: string; providers?: readonly string[]; tools?: readonly string[]; runtimeSeams?: readonly string[]; pluginDependencies?: readonly { capability: string; strength: 'hard' | 'optional' }[] }[] } | undefined)
      ?.list().map((record) => ({
        owner: record.owner,
        version: record.version,
        provenance: record.provenance.kind,
        status: record.status,
        capabilities: record.capabilities.map((item) => item.id),
        ...(record.permissions ? { permissions: [...record.permissions] } : {}),
        ...(record.provider ? { provider: record.provider } : {}),
        ...(record.providers ? { providers: [...record.providers] } : {}),
        ...(record.tools ? { tools: [...record.tools] } : {}),
        ...(record.runtimeSeams ? { runtimeSeams: [...record.runtimeSeams] } : {}),
        ...(record.pluginDependencies ? { pluginDependencies: [...record.pluginDependencies] } : {}),
      })) ?? [],
    extensionApprovals: extensionApprovals(ctx),
    activation: {
      state: activation?.state ?? 'idle',
      ...(activation?.current?.generation !== undefined ? { generation: activation.current.generation } : {}),
      ...(activation?.current?.mounted ? { mounted: [...activation.current.mounted] } : {}),
      ...(activation?.pendingCandidateId ? { pendingCandidateId: activation.pendingCandidateId } : {}),
      ...(activation?.lifecycleBusy ? { lifecycleBusy: activation.lifecycleBusy } : {}),
      ...(activation?.current ? { current: snapshotView(activation.current) } : {}),
      ...(activation?.rollbackTarget ? { rollbackTarget: snapshotView(activation.rollbackTarget) } : {}),
      ...(activation?.lastKnownGood ? { lastKnownGood: snapshotView(activation.lastKnownGood) } : {}),
      ...(lastFailure?.candidateId ? { lastFailureCandidateId: lastFailure.candidateId } : {}),
      ...(lastFailure && boundedFailure
        ? {
          lastFailure: {
            candidateId: lastFailure.candidateId ?? '',
            phase: lastFailure.phase ?? 'prepare',
            diagnostics: boundedFailure,
            rollbackSucceeded: lastFailure.rollbackSucceeded === true,
            safeModeRequired: lastFailure.safeModeRequired === true,
          },
        }
        : {}),
      ...(activation?.rollbackPlan ? { rollbackPlan: activation.rollbackPlan } : {}),
    },
    candidates: workbenchCandidates(ctx),
    skills: skillProjections(ctx),
    ...(skillCatalogOf(ctx) ? { skillCatalog: skillCatalogOf(ctx) } : {}),
    ...(skillEventsOf(ctx).length > 0 ? { skillEvents: skillEventsOf(ctx) } : {}),
    ...(skillRollbackOf(ctx) ? { skillRollback: skillRollbackOf(ctx)! } : {}),
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
    ...(contextEndurance ? { contextEndurance } : {}),
    materialInput,
    ...(input.objective ? { objective: input.objective } : {}),
    personality: {
      humor: personality.humor,
      directness: personality.directness,
      initiative: personality.initiative,
      verbosity: personality.verbosity,
      humorSuppressed: personality.humorSuppressed,
    },
    ...(runtimeContext ? { runtimeContext } : {}),
    ...(input.sessions ? { sessions: input.sessions } : {}),
    ...(input.approvalOrigins ? { approvalOrigins: input.approvalOrigins } : {}),
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

function finalAssistantSeqs(events: readonly SessionEvent[]): ReadonlySet<number> {
  const final = new Set<number>()
  let assistantSeq: number | undefined
  let executionSeq = -1
  const flush = () => {
    if (assistantSeq !== undefined && assistantSeq > executionSeq) final.add(assistantSeq)
    assistantSeq = undefined
    executionSeq = -1
  }
  for (const event of events) {
    if (event.type === 'user/message' && isAppendSurfaceEvent(event) && isHumanUserMessage(event.data)) flush()
    if (event.type === 'assistant/message' && isAppendSurfaceEvent(event) && visibleText(event.data.message.content).trim()) assistantSeq = event.seq
    if (event.type === 'tool/call' || (event.type === 'tool/result' && isAppendSurfaceEvent(event))) executionSeq = event.seq
  }
  flush()
  return final
}

export function conversationWithoutReasoning(events: readonly SessionEvent[]): WorkspaceSnapshotInput['conversation'] {
  const items: WorkspaceSnapshotInput['conversation'][number][] = []
  const finalAssistant = finalAssistantSeqs(events)
  for (const event of events) {
    if (event.type === 'user/message' && isAppendSurfaceEvent(event)) {
      if (!isHumanUserMessage(event.data)) continue
      items.push({ kind: 'user', text: visibleText(event.data.content) })
    }
    if (event.type === 'assistant/message' && isAppendSurfaceEvent(event)) {
      if (!finalAssistant.has(event.seq)) continue
      items.push({ kind: 'assistant', text: visibleText(event.data.message.content) })
    }
  }
  return items
}

export function executionLogFromSession(events: readonly SessionEvent[]): readonly ExecutionLogEntry[] {
  const entries: ExecutionLogEntry[] = []
  const finalAssistant = finalAssistantSeqs(events)
  let lastCall: { readonly id: string; readonly name: string } | undefined
  for (const event of events) {
    if (event.type === 'assistant/message' && isAppendSurfaceEvent(event) && !finalAssistant.has(event.seq)) {
      const detail = visibleText(event.data.message.content).trim()
      if (detail) entries.push({ id: `agent-${event.seq}`, seq: event.seq, time: event.time, kind: 'agent-note', label: 'AGENT', detail })
      continue
    }
    if (event.type === 'tool/call') {
      const callId = String(event.data.callId)
      lastCall = { id: callId, name: event.data.name }
      entries.push({ id: `call-${event.seq}`, seq: event.seq, time: event.time, kind: 'tool-call', label: event.data.name, detail: event.data.arguments, callId })
      continue
    }
    if (event.type === 'tool/result' && isAppendSurfaceEvent(event)) {
      const callId = lastCall?.id
      entries.push({
        id: `result-${event.seq}`,
        seq: event.seq,
        time: event.time,
        kind: 'tool-result',
        label: lastCall?.name ?? 'tool result',
        detail: visibleText(event.data.message.content),
        ...(callId ? { callId } : {}),
        isError: event.data.error !== undefined,
      })
    }
  }
  return entries
}

function isHumanUserMessage(message: { readonly source: { readonly kind: string; readonly form?: string }; readonly content: readonly ContentBlock[] }): boolean {
  const source = message.source
  if (source.kind === 'plugin') return false
  if (source.form === 'snapshot' || source.form === 'instructions' || source.form === 'catalog' || source.form === 'control') return false
  if (source.kind === 'host' || source.kind === 'system') return false
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

function skillCatalogOf(ctx: Context): WorkspaceSnapshotInput['skillCatalog'] {
  const skills = ctx.get('skillLifecycle') as {
    health(): {
      catalog: 'ok' | 'empty' | 'degraded' | 'withheld'
      failed: readonly string[]
      recoveryRequired: boolean
      catalogDetail?: string
    }
  } | undefined
  const health = skills?.health()
  if (health === undefined) return undefined
  return {
    state: health.catalog,
    failed: [...health.failed],
    recoveryRequired: health.recoveryRequired,
    ...(health.catalogDetail ? { detail: health.catalogDetail } : {}),
  }
}

function skillEventsOf(ctx: Context): NonNullable<WorkspaceSnapshotInput['skillEvents']> {
  const skills = ctx.get('skillLifecycle') as {
    events(): readonly {
      id: string
      kind: string
      name?: string
      version?: string
      detail?: string
    }[]
  } | undefined
  return (skills?.events() ?? []).map((item) => ({
    id: item.id,
    kind: item.kind,
    ...(item.name ? { name: item.name } : {}),
    ...(item.version ? { version: item.version } : {}),
    ...(item.detail ? { detail: item.detail } : {}),
  }))
}

function skillRollbackOf(ctx: Context): WorkspaceSnapshotInput['skillRollback'] {
  const skills = ctx.get('skillLifecycle') as {
    health(): { generation: number; rollbackTarget?: { name: string; version: string; digest: string } }
  } | undefined
  const health = skills?.health()
  return health?.rollbackTarget === undefined ? undefined : { ...health.rollbackTarget, generation: health.generation }
}

function skillProjections(ctx: Context): WorkspaceSnapshotInput['skills'] {
  const skills = ctx.get('skillLifecycle') as {
    health(): { generation: number }
    diff(id: string): NonNullable<WorkspaceSnapshotInput['skills']>[number]['revisionDiff']
    list(): readonly {
      id: string
      name: string
      version: string
      profile: string
      provenance: { kind: string; origin: string }
      lifecycle: string
      sealed: boolean
      invocation: { modelInvocable: boolean; userInvocable: boolean }
      description: string
      whenToUse?: string
      resources: readonly string[]
      validationPassed: boolean
      reviewComplete: boolean
      approvalDecision?: string
      approvalFingerprint?: string
      digest: string
      baseVersion?: string
      dependsOn?: readonly { name: string; version: string }[]
      dependents?: readonly string[]
      lastFailure?: { phase: string; detail: string }
      resolutionHandoff?: { missingTools: readonly string[]; nextAction: 'capability-resolution' }
    }[]
    inspect(id: string): { dependents: readonly string[] }
  } | undefined
  if (skills === undefined) return []
  const generation = skills.health().generation
  return skills.list().map((item) => ({
    id: item.id,
    name: item.name,
    version: item.version,
    profile: item.profile,
    provenance: item.provenance.kind,
    origin: item.provenance.origin,
    lifecycle: item.lifecycle,
    sealed: item.sealed,
    modelInvocable: item.invocation.modelInvocable,
    userInvocable: item.invocation.userInvocable,
    description: item.description,
    ...(item.whenToUse ? { whenToUse: item.whenToUse } : {}),
    resources: [...item.resources],
    validationPassed: item.validationPassed,
    reviewComplete: item.reviewComplete,
    ...(item.approvalDecision ? { approvalDecision: item.approvalDecision } : {}),
    ...(item.approvalFingerprint && item.lifecycle === 'approval-requested' ? { approvalFingerprint: item.approvalFingerprint } : {}),
    digest: item.digest,
    ...(item.baseVersion ? { baseVersion: item.baseVersion } : {}),
    dependsOn: (item.dependsOn ?? []).map((dep) => `${dep.name}@${dep.version}`),
    dependents: [...(skills.inspect(item.id).dependents ?? item.dependents ?? [])],
    system: item.provenance.kind === 'system',
    generation,
    ...(item.lastFailure ? { lastFailure: item.lastFailure } : {}),
    ...(item.resolutionHandoff ? { resolutionHandoff: item.resolutionHandoff } : {}),
    revisionDiff: skills.diff(item.id),
  }))
}

function workbenchCandidates(ctx: Context): WorkspaceSnapshotInput['candidates'] {
  const workbench = ctx.get('candidateWorkbench') as { inspect(id: string): {
    id: string
    owner: string
    version: string
    digest?: string
    baseVersion?: string
    provenance?: { kind: string; origin?: string }
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
      provenance?: { kind: string; origin?: string }
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
        digest: view.digest,
        baseVersion: view.baseVersion,
        ...(view.provenance ? { provenance: view.provenance } : {}),
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
        ...projectedLifecycle({
          candidateId: view.id,
          owner: view.owner,
          version: view.version,
          canRequest: view.requestEligibility.ok,
          decision: (ctx.get('extensionGovernance') as { inspectApproval?(id: string): { decision: string } | undefined } | undefined)
            ?.inspectApproval?.(view.id)?.decision,
          eligibilityDenials: (ctx.get('extensionGovernance') as { eligibility?(id: string): { denials: readonly { reason: string }[] } } | undefined)
            ?.eligibility?.(view.id)?.denials.map((item) => item.reason),
          registry: ctx.get('capabilityRegistry') as { get(owner: string, version: string): { status: string } | undefined } | undefined,
          activation: ctx.get('extensionRecovery') as {
            inspect(): {
              state?: string
              pendingCandidateId?: string
              lastFailure?: { candidateId?: string; diagnostics?: string }
            }
          } | undefined,
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
      digest: record.digest,
      baseVersion: record.baseVersion,
      ...(record.provenance ? { provenance: record.provenance } : {}),
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
      capabilities: { added: readonly string[]; removed: readonly string[]; changed?: readonly string[] }
      permissions: { added: readonly string[]; removed: readonly string[]; changed?: readonly string[] }
      tools?: { added: readonly string[]; removed: readonly string[]; changed?: readonly string[] }
      secrets: readonly string[]
      effects: { filesystem: readonly string[]; network: readonly string[]; process: readonly string[]; secrets: readonly string[]; externalSystems: readonly string[] }
    }
    eligibility?(id: string): { ok: boolean; denials: readonly { reason: string }[] }
  } | undefined
  const workspace = ctx.get('candidateWorkspace') as {
    list(): { id: string; manifest?: { runtimeContractVersion?: string } }[]
    get?(id: string): { manifest?: { runtimeContractVersion?: string } }
  } | undefined
  if (!governance?.inspectApproval || !workspace) return []
  const out: Array<NonNullable<WorkspaceSnapshotInput['extensionApprovals']>[number]> = []
  for (const candidate of workspace.list()) {
    const record = governance.inspectApproval(candidate.id) as { id: string; fingerprint: string; decision: string } | undefined
    if (!record) continue
    const summary = governance.inspectSummary?.(candidate.id)
    if (!summary) continue
    const eligibility = governance.eligibility?.(candidate.id)
    const contract = workspace.get?.(candidate.id)?.manifest?.runtimeContractVersion ?? candidate.manifest?.runtimeContractVersion
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
      capabilitiesChanged: [...(summary.capabilities.changed ?? [])],
      permissionsAdded: [...(summary.permissions.added ?? [])],
      permissionsRemoved: [...(summary.permissions.removed ?? [])],
      permissionsChanged: [...(summary.permissions.changed ?? [])],
      effects: flattenEffects(summary.effects, summary.secrets ?? []),
      toolsAdded: [...(summary.tools?.added ?? [])],
      toolsRemoved: [...(summary.tools?.removed ?? [])],
      toolsChanged: [...(summary.tools?.changed ?? [])],
      ...(contract ? { runtimeContractVersion: contract } : {}),
      eligibilityOk: eligibility?.ok !== false,
      eligibilityDenials: eligibility?.denials.map((item) => item.reason) ?? [],
    })
  }
  return out
}

function boundFailureSummary(failed?: readonly string[]): string | undefined {
  if (!failed?.length) return undefined
  const text = failed.join(', ')
  return text.length > 160 ? `${text.slice(0, 148)}[truncated]` : text
}

function projectedLifecycle(input: {
  readonly candidateId: string
  readonly owner: string
  readonly version: string
  readonly canRequest: boolean
  readonly decision?: string
  readonly eligibilityDenials?: readonly string[]
  readonly registry?: {
    get(owner: string, version: string): { status: string } | undefined
    list?(): readonly { owner: string; version: string; status: string }[]
  }
  readonly activation?: {
    inspect(): {
      state?: string
      pendingCandidateId?: string
      lastFailure?: { candidateId?: string; diagnostics?: string }
    }
  }
}): Pick<import('./types.js').WorkbenchProjection, 'approvalState' | 'governanceApproval' | 'activationState' | 'extensionLifecycle' | 'activationFailureSummary'> {
  const inspected = input.activation?.inspect()
  const lifecycle = extensionLifecycleOf({
    registryStatus: input.registry?.get(input.owner, input.version)?.status,
    decision: input.decision,
    activationState: inspected?.state,
    pendingCandidateId: inspected?.pendingCandidateId,
    candidateId: input.candidateId,
    lastFailureCandidateId: inspected?.lastFailure?.candidateId,
    eligibilityDenials: input.eligibilityDenials,
    newerAuthoritative: newerAuthoritative(input.registry, input.owner, input.version),
  })
  let approvalState: import('./types.js').WorkbenchProjection['approvalState'] = approvalStateOf(lifecycle, input.decision)
  if (lifecycle === 'APPROVAL_REQUIRED') {
    if (input.decision === 'approval-requested') approvalState = 'approval-requested'
    else if (input.canRequest) approvalState = 'ready-for-approval'
    else approvalState = 'not-ready'
  }
  const failure = inspected?.lastFailure
  return {
    approvalState,
    governanceApproval: input.decision,
    activationState: activationViewOf(lifecycle),
    extensionLifecycle: lifecycle,
    ...(lifecycle === 'ACTIVATION_FAILED' && failure?.diagnostics
      ? { activationFailureSummary: boundActivationDiagnostics(failure.diagnostics) }
      : {}),
  }
}

function newerAuthoritative(
  registry: { list?(): readonly { owner: string; version: string; status: string }[] } | undefined,
  owner: string,
  version: string,
): boolean {
  return registry?.list?.().some((item) => (
    item.owner === owner
    && item.status === 'active'
    && compareOwnerVersion(item.version, version) > 0
  )) === true
}

function snapshotView(input: {
  readonly generation: number
  readonly mounted?: readonly string[]
  readonly owners: readonly { owner: string; version: string; status?: string; capabilities?: readonly string[] }[]
}) {
  return {
    generation: input.generation,
    ...(input.mounted ? { mounted: [...input.mounted] } : {}),
    owners: input.owners.map((item) => ({
      owner: item.owner,
      version: item.version,
      ...(item.status ? { status: item.status } : {}),
      ...(item.capabilities ? { capabilities: [...item.capabilities] } : {}),
    })),
  }
}
