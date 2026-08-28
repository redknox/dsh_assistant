import type { ApprovalCard, MissionControlView } from '../domain/workspace/types.js'

type ApprovalDecision = 'approve' | 'deny' | 'cancel'

export interface WebUiApprovalRequest {
  readonly method?: string
  readonly pathname: string
  readonly readJson: () => Promise<unknown>
}

export interface WebUiApprovalContext {
  readonly approvals: () => readonly ApprovalCard[]
  readonly resolveApproval: (card: ApprovalCard, decision: ApprovalDecision) => Promise<unknown>
  readonly recordSelfExtensionApproval: (input: {
    readonly candidateId: string
    readonly fingerprint: string
    readonly decision: 'approved-for-exact-diff' | 'rejected'
  }) => void
  readonly acknowledgementFor: (id: string) => { readonly text: string } | undefined
  readonly project: (acknowledgement?: { readonly text: string }) => {
    readonly view: MissionControlView
    readonly webUi: string
    readonly acknowledgement?: { readonly text: string }
  }
}

export interface WebUiApprovalResponse {
  readonly status: number
  readonly body: unknown
  readonly broadcast?: boolean
}

export async function handleWebUiApprovalRequest(
  request: WebUiApprovalRequest,
  context: WebUiApprovalContext,
): Promise<WebUiApprovalResponse | undefined> {
  const decision = decisionFor(request.method, request.pathname)
  if (!decision) return undefined

  const bound = bindApproval(await request.readJson(), context.approvals())
  if ('error' in bound) {
    return { status: bound.error === 'malformed' ? 400 : 409, body: { error: bound.error } }
  }

  const { card } = bound
  if (card.kind === 'self-extension') {
    if (decision === 'cancel') {
      return { status: 409, body: { error: 'unsupported', action: 'cancel-self-extension' } }
    }
    context.recordSelfExtensionApproval({
      candidateId: card.candidateId ?? '',
      fingerprint: card.fingerprint,
      decision: decision === 'approve' ? 'approved-for-exact-diff' : 'rejected',
    })
  } else {
    await context.resolveApproval(card, decision)
  }

  return {
    status: 200,
    body: context.project(context.acknowledgementFor(card.id)),
    broadcast: true,
  }
}

function decisionFor(method: string | undefined, pathname: string): ApprovalDecision | undefined {
  if (method !== 'POST') return undefined
  if (pathname === '/api/approve') return 'approve'
  if (pathname === '/api/deny') return 'deny'
  if (pathname === '/api/cancel') return 'cancel'
  return undefined
}

function bindApproval(
  body: unknown,
  cards: readonly ApprovalCard[],
): { readonly card: ApprovalCard } | { readonly error: string } {
  if (!isRecord(body) || typeof body.id !== 'string' || body.id === '') return { error: 'malformed' }
  if (typeof body.fingerprint !== 'string' || body.fingerprint === '') return { error: 'malformed' }
  const card = cards.find((item) => item.id === body.id)
  if (!card) return { error: 'unknown-approval' }
  if (card.fingerprint !== body.fingerprint) return { error: 'stale-fingerprint' }
  if (card.kind === 'self-extension') {
    if (typeof body.candidateId !== 'string' || body.candidateId === '' || body.candidateId !== card.candidateId) {
      return { error: 'stale-candidate' }
    }
  }
  if (card.status !== 'pending' && card.status !== 'approval-requested' && card.status !== 'unreviewed') {
    return { error: 'stale-approval' }
  }
  return { card }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
