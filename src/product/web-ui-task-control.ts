import type { MissionControlView } from '../domain/workspace/types.js'

export interface WebUiTaskControlRequest {
  readonly method?: string
  readonly pathname: string
  readonly readJson: () => Promise<unknown>
}

export interface WebUiTaskControlContext {
  readonly control: (action: 'pause' | 'resume', id: string, revision: number) => unknown
  readonly project: (acknowledgement: { readonly text: string }) => {
    readonly view: MissionControlView
    readonly webUi: string
    readonly acknowledgement?: { readonly text: string }
  }
}

export interface WebUiTaskControlResponse {
  readonly status: number
  readonly body: unknown
  readonly broadcast?: boolean
}

/** Bind a human pause/resume decision to one exact current Goal revision. */
export async function handleWebUiTaskControlRequest(
  request: WebUiTaskControlRequest,
  context: WebUiTaskControlContext,
): Promise<WebUiTaskControlResponse | undefined> {
  if (request.method !== 'POST' || request.pathname !== '/api/task-control') return undefined
  const body = await request.readJson()
  if (!isRecord(body)
    || (body.action !== 'pause' && body.action !== 'resume')
    || typeof body.id !== 'string'
    || body.id === ''
    || !Number.isSafeInteger(body.revision)
    || (body.revision as number) < 1) {
    return { status: 400, body: { error: 'malformed' } }
  }
  context.control(body.action, body.id, body.revision as number)
  return {
    status: 200,
    body: context.project({ text: body.action === 'pause' ? 'Goal paused.' : 'Goal resumed.' }),
    broadcast: true,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
