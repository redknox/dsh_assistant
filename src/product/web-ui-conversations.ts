import type { MissionControlView } from '../domain/workspace/types.js'
import { SessionCatalogError } from './session-catalog.js'

interface ConversationSessionHost {
  assertAcceptingMessages(): void
  touchPreview(text: string): void
  create(title: string | undefined, expected: SessionExpectation): Promise<unknown>
  switchTo(id: string, expected: SessionExpectation): Promise<unknown>
  rename(id: string, title: string, expected: SessionExpectation): Promise<unknown>
  archive(id: string, expected: SessionExpectation): Promise<unknown>
  restore(id: string, expected: SessionExpectation): Promise<unknown>
  delete(id: string, expected: SessionExpectation & { readonly confirm: boolean }): Promise<unknown>
}

interface SessionExpectation {
  readonly sessionId: string
  readonly revision: number
}

export interface WebUiConversationRequest {
  readonly method?: string
  readonly pathname: string
  readonly readJson: () => Promise<unknown>
}

export interface WebUiConversationContext {
  readonly currentSessionId: () => string
  readonly sendMessage: (text: string) => void
  readonly sessionHost?: ConversationSessionHost
  readonly project: (acknowledgement?: { readonly text: string }) => {
    readonly view: MissionControlView
    readonly webUi: string
    readonly acknowledgement?: { readonly text: string }
  }
}

export interface WebUiConversationResponse {
  readonly status: number
  readonly body: unknown
  readonly broadcast?: boolean
}

export async function handleWebUiConversationRequest(
  request: WebUiConversationRequest,
  context: WebUiConversationContext,
): Promise<WebUiConversationResponse | undefined> {
  if (request.method !== 'POST') return undefined
  if (request.pathname === '/api/message') return handleMessage(await request.readJson(), context)
  if (request.pathname === '/api/conversations') return handleConversation(await request.readJson(), context)
  return undefined
}

function handleMessage(body: unknown, context: WebUiConversationContext): WebUiConversationResponse {
  if (!isRecord(body) || typeof body.text !== 'string' || body.text.trim() === '' || typeof body.sessionId !== 'string') {
    return { status: 400, body: { error: 'malformed' } }
  }
  if (body.sessionId !== context.currentSessionId()) {
    return conflict('stale-session', 'request targeted a different current session', context)
  }
  try {
    context.sessionHost?.assertAcceptingMessages()
  } catch (error) {
    if (error instanceof SessionCatalogError) return conflict(error.code, error.message, context)
    throw error
  }
  const text = body.text.trim()
  context.sendMessage(text)
  context.sessionHost?.touchPreview(text)
  return { status: 202, body: context.project(), broadcast: true }
}

async function handleConversation(body: unknown, context: WebUiConversationContext): Promise<WebUiConversationResponse> {
  const host = context.sessionHost
  if (!host) {
    return { status: 409, body: { error: 'unavailable', detail: 'session catalog is unavailable' } }
  }
  if (!isRecord(body)
    || typeof body.action !== 'string'
    || typeof body.sessionId !== 'string'
    || typeof body.revision !== 'number') {
    return { status: 400, body: { error: 'malformed' } }
  }

  const expected = { sessionId: body.sessionId, revision: body.revision }
  try {
    const acknowledgement = await executeConversationAction(host, body, expected)
    if (!acknowledgement) return { status: 409, body: { error: 'unsupported', action: body.action } }
    return { status: 200, body: context.project(acknowledgement), broadcast: true }
  } catch (error) {
    if (error instanceof SessionCatalogError) {
      return conflict(error.code, error.message, context, error.code === 'not-found' ? 404 : 409)
    }
    throw error
  }
}

async function executeConversationAction(
  host: ConversationSessionHost,
  body: Record<string, unknown>,
  expected: SessionExpectation,
): Promise<{ readonly text: string } | undefined> {
  if (body.action === 'create') {
    await host.create(typeof body.title === 'string' ? body.title : undefined, expected)
    return { text: 'Created a new conversation.' }
  }
  if (body.action === 'switch' && typeof body.id === 'string') {
    await host.switchTo(body.id, expected)
    return { text: 'Switched conversation.' }
  }
  if (body.action === 'rename' && typeof body.id === 'string' && typeof body.title === 'string') {
    await host.rename(body.id, body.title, expected)
    return { text: 'Renamed conversation.' }
  }
  if (body.action === 'archive' && typeof body.id === 'string') {
    await host.archive(body.id, expected)
    return { text: 'Archived conversation.' }
  }
  if (body.action === 'restore' && typeof body.id === 'string') {
    await host.restore(body.id, expected)
    return { text: 'Restored conversation.' }
  }
  if (body.action === 'delete' && typeof body.id === 'string') {
    await host.delete(body.id, { ...expected, confirm: body.confirm === true })
    return { text: 'Deleted conversation.' }
  }
  return undefined
}

function conflict(
  error: string,
  detail: string,
  context: WebUiConversationContext,
  status = 409,
): WebUiConversationResponse {
  return { status, body: { error, detail, ...context.project() } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
