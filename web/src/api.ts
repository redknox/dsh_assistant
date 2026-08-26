import type { ActivationCard, ApprovalCard, MissionControlView, RollbackCard, SkillProjection, UserPluginView, WorkObjectKind } from '../../src/domain/workspace/types'

export interface UiEnvelope {
  readonly view: MissionControlView
  readonly webUi: string
  readonly acknowledgement?: { readonly text: string }
}

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

export async function sendMessage(text: string, sessionId: string): Promise<UiEnvelope> {
  return parseEnvelope(await fetch('/api/message', {
    ...include,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, sessionId }),
  }))
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

export function formatMarkdownLite(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replaceAll(/`([^`]+)`/g, '<code>$1</code>')
}

export function approvalLabel(card: ApprovalCard): string {
  return `${card.title} · ${card.status}`
}

export function recoveryActionId(label: string): 'diagnostics' | 'rollback' | 'exit-safe-mode' | undefined {
  if (label === 'Diagnostics') return 'diagnostics'
  if (label === 'Rollback') return 'rollback'
  if (label === 'Exit Safe Mode') return 'exit-safe-mode'
  return undefined
}
