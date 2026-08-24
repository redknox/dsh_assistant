import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, isAppendSurfaceEvent, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { humorSuppressed } from '../personality/effective.js'
import type { TarsPersonality } from '../personality/types.js'
import { flattenEffects, summarizeCandidateEffects } from './effects.js'
import { boundActivationDiagnostics } from './failure.js'
import { activationViewOf, approvalStateOf, compareOwnerVersion, extensionLifecycleOf } from './lifecycle.js'
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
      state?: string
      pendingCandidateId?: string
      lifecycleBusy?: 'activation' | 'uninstall' | 'recovery'
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
  const safeMode = Boolean(activation?.safeMode)
  const lastFailure = activation?.lastFailure
  const boundedFailure = lastFailure?.diagnostics ? boundActivationDiagnostics(lastFailure.diagnostics) : undefined
  return {
    agentStatus: agent?.status,
    safeMode,
    recoveryRequired: Boolean(activation?.recoveryRequired),
    ...(activation?.recoveryRequired && boundedFailure
      ? { recoveryWhy: boundedFailure }
      : safeMode
        ? { recoveryWhy: 'Generated capabilities are disabled. Trusted core is available.' }
        : {}),
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
    digest?: string
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
        digest: view.digest,
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
  let approvalState: import('./types.js').WorkbenchProjection['approvalState'] = approvalStateOf(lifecycle)
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
