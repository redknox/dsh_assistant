import type { ActivationCard, ApprovalCard, MissionControlView, RollbackCard, SkillProjection, UserPluginView, WorkObjectKind } from '../../src/domain/workspace/types'
import type { SettingsSnapshot, SettingsUpdate } from '../../src/product/settings-types'
import type { ExpenseReviewAvailability, ExpenseReviewInput, ExpenseReviewRecord } from '../../src/domain/expense-review/types'
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import type { ToolCatalogView } from '../../src/domain/tool-catalog/index'
import type {
  CapabilitySpecificationDiffView,
  CapabilityEvaluationView,
  CapabilitySpecificationRevisionInput,
  CapabilitySpecificationCreateInput,
  CapabilitySpecificationView,
  WorkbenchSnapshotView,
} from '../../src/product/web-ui-workbench-types'

export interface UiEnvelope {
  readonly view: MissionControlView
  readonly webUi: string
  readonly commands?: readonly CommandDescriptor[]
  readonly toolCatalog?: ToolCatalogView
  readonly acknowledgement?: { readonly text: string }
}

export type WorkbenchSnapshot = WorkbenchSnapshotView

const include: RequestInit = { credentials: 'include', cache: 'no-store' }

async function parseEnvelope(response: Response): Promise<UiEnvelope> {
  const body = await response.json() as UiEnvelope & { error?: string; detail?: string; dependents?: readonly string[] }
  if (!response.ok) {
    const error = new Error(body.detail ?? recoveryFailureText(body.error) ?? `request failed (${response.status})`) as Error & {
      code?: string
      dependents?: readonly string[]
    }
    error.code = body.error
    if (body.dependents) error.dependents = body.dependents
    throw error
  }
  return body
}

function recoveryFailureText(error: string | undefined): string | undefined {
  if (error === 'integrity-failure') {
    return 'Exit Safe Mode is refused while recovery is still required. Restore the selected Profile and restart; this button does not repair a broken Profile.'
  }
  if (error === 'profile-composition-recovery') {
    return 'Exit Safe Mode cannot repair a broken Profile. Restore profiles/assistant and restart TARS-NG.'
  }
  if (error === 'stale-session' || error === 'stale-revision') return 'Conversation list changed; retry the action.'
  if (error === 'last-active') return 'The last active conversation cannot be removed.'
  if (error === 'confirmation-required') return 'Confirm the recovery action.'
  if (error === 'untrusted session') return 'Web UI session is untrusted; reload the page.'
  return error
}

export async function establishSession(): Promise<void> {
  await fetch('/api/session', include)
}

export async function fetchView(): Promise<UiEnvelope> {
  return parseEnvelope(await fetch('/api/view', include))
}

export async function fetchSettings(): Promise<SettingsSnapshot> {
  const response = await fetch('/api/settings', include)
  const body = await response.json() as SettingsSnapshot & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `settings request failed (${response.status})`)
  return body
}

export async function saveSettings(input: SettingsUpdate): Promise<SettingsSnapshot> {
  const response = await fetch('/api/settings', {
    ...include,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = await response.json() as SettingsSnapshot & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `settings update failed (${response.status})`)
  return body
}

export async function fetchExpenseReviewAvailability(): Promise<ExpenseReviewAvailability> {
  return parseJson<ExpenseReviewAvailability>(await fetch('/api/expense-review', include), 'expense review availability')
}

export async function submitExpenseReview(input: ExpenseReviewInput): Promise<ExpenseReviewRecord> {
  return parseJson<ExpenseReviewRecord>(await fetch('/api/expense-review', {
    ...include,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }), 'expense review')
}

export async function fetchWorkbench(): Promise<WorkbenchSnapshot> {
  return parseJson<WorkbenchSnapshot>(await fetch('/api/workbench', include), 'workbench request')
}

export async function fetchCapabilitySpecification(id: string): Promise<CapabilitySpecificationView> {
  return parseJson<CapabilitySpecificationView>(
    await fetch(`/api/workbench/specification?id=${encodeURIComponent(id)}`, include),
    'capability specification request',
  )
}

export async function fetchCapabilityEvaluation(id: string): Promise<CapabilityEvaluationView> {
  return parseJson<CapabilityEvaluationView>(
    await fetch(`/api/workbench/evaluation?id=${encodeURIComponent(id)}`, include),
    'capability evaluation request',
  )
}

export async function compareCapabilitySpecificationRevisions(from: string, to: string): Promise<CapabilitySpecificationDiffView> {
  return parseJson<CapabilitySpecificationDiffView>(
    await fetch(`/api/workbench/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, include),
    'capability specification comparison',
  )
}

export async function reviseCapabilitySpecification(
  specificationId: string,
  patch: CapabilitySpecificationRevisionInput,
): Promise<CapabilitySpecificationView> {
  return parseJson<CapabilitySpecificationView>(await fetch('/api/workbench/specification/revise', {
    ...include,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ specificationId, patch }),
  }), 'capability specification revision')
}

export async function defineCapabilitySpecification(
  input: CapabilitySpecificationCreateInput,
): Promise<CapabilitySpecificationView> {
  return parseJson<CapabilitySpecificationView>(await fetch('/api/workbench/specification/define', {
    ...include,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }), 'capability specification creation')
}

async function parseJson<T>(response: Response, label: string): Promise<T> {
  const body = await response.json() as T & { readonly error?: string }
  if (!response.ok) throw new Error(body.error ?? `${label} failed (${response.status})`)
  return body
}

export async function sendMessage(text: string, sessionId: string): Promise<UiEnvelope> {
  return parseEnvelope(await fetch('/api/message', {
    ...include,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, sessionId }),
  }))
}

export async function controlGoal(input: {
  readonly action: 'pause' | 'resume'
  readonly id: string
  readonly revision: number
}): Promise<UiEnvelope> {
  return taskControlRequest(input)
}

export async function controlPlan(active: boolean): Promise<UiEnvelope> {
  return taskControlRequest({ action: active ? 'enter-plan' : 'leave-plan' })
}

export async function answerTaskQuestion(id: string, selected: string, custom?: string): Promise<UiEnvelope> {
  return taskControlRequest({ action: 'answer-question', id, selected, ...(custom ? { custom } : {}) })
}

async function taskControlRequest(input: Record<string, unknown>): Promise<UiEnvelope> {
  return parseEnvelope(await fetch('/api/task-control', {
    ...include,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }))
}

export async function listFileReferences(query: string): Promise<readonly FileReferenceCandidate[]> {
  const response = await fetch(`/api/file-references?query=${encodeURIComponent(query)}`, include)
  const body = await response.json() as { readonly candidates?: readonly FileReferenceCandidate[]; readonly error?: string }
  if (!response.ok) throw new Error(body.error ?? `file reference lookup failed (${response.status})`)
  return body.candidates ?? []
}

export interface SessionSearchResult {
  readonly id: string
  readonly title: string
  readonly snippet: string
}

export async function searchSessions(query: string): Promise<readonly SessionSearchResult[]> {
  const response = await fetch(`/api/session-search?query=${encodeURIComponent(query)}`, include)
  const body = await response.json() as { readonly results?: readonly SessionSearchResult[]; readonly error?: string }
  if (!response.ok) throw new Error(body.error ?? `session search failed (${response.status})`)
  return body.results ?? []
}

export async function runConversation(
  action: 'create' | 'switch' | 'rename' | 'archive' | 'restore' | 'delete',
  input: { readonly id?: string; readonly title?: string; readonly sessionId: string; readonly revision: number; readonly confirm?: boolean },
): Promise<UiEnvelope> {
  return parseEnvelope(await fetch('/api/conversations', {
    ...include,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...input }),
  }))
}

export async function decideApproval(card: ApprovalCard, decision: 'approve' | 'deny' | 'cancel'): Promise<UiEnvelope> {
  return parseEnvelope(await fetch(`/api/${decision}`, {
    ...include,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: card.id,
      fingerprint: card.fingerprint,
      ...(card.candidateId ? { candidateId: card.candidateId } : {}),
      ...(card.digest ? { digest: card.digest } : {}),
    }),
  }))
}

export async function runSkillAction(input: {
  readonly action: 'approve' | 'reject' | 'activate' | 'disable' | 'reactivate' | 'uninstall' | 'rollback'
  readonly skill?: SkillProjection
  readonly rollback?: MissionControlView['skillRollback']
  readonly confirm: boolean
  readonly dependents?: readonly string[]
  readonly acknowledgeDependents?: boolean
}): Promise<UiEnvelope> {
  const target = input.action === 'rollback' ? input.rollback : input.skill
  return parseEnvelope(await fetch('/api/skill', {
    ...include,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: input.action,
      confirm: input.confirm,
      id: input.skill?.id,
      name: target?.name,
      version: target?.version,
      digest: target?.digest,
      fingerprint: input.skill?.approvalFingerprint,
      generation: input.action === 'rollback' ? input.rollback?.generation : input.skill?.generation,
      dependents: input.dependents ?? [],
      acknowledgeDependents: input.acknowledgeDependents === true,
    }),
  }))
}

export async function activateCandidate(card: ActivationCard, confirm: boolean): Promise<UiEnvelope> {
  return parseEnvelope(await fetch('/api/activate', {
    ...include,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: card.id,
      candidateId: card.candidateId,
      digest: card.digest,
      fingerprint: card.fingerprint,
      confirm,
    }),
  }))
}

export async function abandonCandidateActivation(card: ActivationCard, confirm: boolean): Promise<UiEnvelope> {
  return parseEnvelope(await fetch('/api/activation/abandon', {
    ...include,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: card.id,
      candidateId: card.candidateId,
      digest: card.digest,
      fingerprint: card.fingerprint,
      confirm,
    }),
  }))
}

export async function uninstallPlugin(plugin: UserPluginView, confirm: boolean): Promise<UiEnvelope> {
  return parseEnvelope(await fetch('/api/uninstall', {
    ...include,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: plugin.id,
      owner: plugin.owner,
      version: plugin.version,
      registryGeneration: plugin.registryGeneration,
      confirm,
      acknowledgeDependents: true,
      ...(plugin.candidateId ? { candidateId: plugin.candidateId } : {}),
      ...(plugin.digest ? { digest: plugin.digest } : {}),
    }),
  }))
}

export async function rollbackSystemState(card: RollbackCard, confirm: boolean): Promise<UiEnvelope> {
  return parseEnvelope(await fetch('/api/rollback', {
    ...include,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: card.id,
      fingerprint: card.fingerprint,
      currentGeneration: card.currentGeneration,
      targetGeneration: card.targetGeneration,
      confirm,
    }),
  }))
}

export async function runRecovery(action: 'diagnostics' | 'rollback' | 'exit-safe-mode', confirm = false): Promise<UiEnvelope> {
  return parseEnvelope(await fetch('/api/recovery', {
    ...include,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, confirm }),
  }))
}

export function openViewStream(onView: (envelope: UiEnvelope) => void, onStatus: (connected: boolean) => void): () => void {
  const source = new EventSource('/api/events')
  source.addEventListener('open', () => onStatus(true))
  source.addEventListener('view', (event) => {
    onStatus(true)
    onView(JSON.parse((event as MessageEvent).data) as UiEnvelope)
  })
  source.addEventListener('error', () => onStatus(false))
  return () => source.close()
}

export function workTone(kind: WorkObjectKind): string {
  if (kind === 'approval-request') return 'approval'
  if (kind === 'failure' || kind === 'warning') return 'alert'
  if (kind === 'recovery') return 'recovery'
  return 'message'
}

export function approvalLabel(card: ApprovalCard): string {
  return `${card.title} · ${card.status}`
}
