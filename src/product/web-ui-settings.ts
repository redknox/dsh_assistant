import type { SettingsSnapshot, SettingsUpdate } from './settings-types.js'

export interface WebUiSettingsRequest {
  readonly method?: string
  readonly pathname: string
  readonly readJson: () => Promise<unknown>
}

export interface WebUiSettingsContext {
  readonly inspect: () => SettingsSnapshot
  readonly update: (input: SettingsUpdate) => SettingsSnapshot
}

export async function handleWebUiSettingsRequest(
  request: WebUiSettingsRequest,
  context: WebUiSettingsContext,
): Promise<{ readonly status: number; readonly body: unknown } | undefined> {
  if (request.pathname !== '/api/settings') return undefined
  if (request.method === 'GET') return { status: 200, body: context.inspect() }
  if (request.method !== 'POST') return { status: 405, body: { error: 'method-not-allowed' } }
  const body = await request.readJson()
  if (!isUpdate(body)) return { status: 400, body: { error: 'malformed-settings' } }
  try {
    return { status: 200, body: context.update(body) }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid-settings'
    return { status: message === 'stale-settings' ? 409 : 400, body: { error: message } }
  }
}

function isUpdate(value: unknown): value is SettingsUpdate {
  if (!isRecord(value) || typeof value.revision !== 'string' || !Array.isArray(value.changes)) return false
  return value.changes.every((change) => (
    isRecord(change)
    && typeof change.id === 'string'
    && (change.value === undefined || typeof change.value === 'string')
    && (change.clear === undefined || typeof change.clear === 'boolean')
  ))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
