import type { ApprovalCard, MissionControlView, WorkObjectKind } from '../../src/domain/workspace/types'

export interface UiEnvelope {
  readonly view: MissionControlView
  readonly webUi: string
}

async function parseEnvelope(response: Response): Promise<UiEnvelope> {
  const body = await response.json() as UiEnvelope & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `request failed (${response.status})`)
  return body
}

export async function fetchView(): Promise<UiEnvelope> {
  return parseEnvelope(await fetch('/api/view', { cache: 'no-store' }))
}

export async function sendMessage(text: string): Promise<UiEnvelope> {
  return parseEnvelope(await fetch('/api/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  }))
}

export async function decideApproval(id: string, decision: 'approve' | 'deny' | 'cancel'): Promise<UiEnvelope> {
  return parseEnvelope(await fetch(`/api/${decision}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  }))
}

export async function runRecovery(action: 'diagnostics' | 'rollback' | 'restart-normally'): Promise<UiEnvelope> {
  return parseEnvelope(await fetch('/api/recovery', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
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
