import type { MissionControlView } from '../domain/workspace/types.js'

export interface WebUiTaskControlRequest {
  readonly method?: string
  readonly pathname: string
  readonly readJson: () => Promise<unknown>
}

export interface WebUiTaskControlContext {
  readonly controlGoal: (action: 'pause' | 'resume', id: string, revision: number) => unknown
  readonly controlPlan: (active: boolean) => unknown
  readonly answerQuestion: (id: string, selected: string, custom?: string) => unknown
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
  if (!isRecord(body) || typeof body.action !== 'string') {
    return { status: 400, body: { error: 'malformed' } }
  }
  let text: string
  if (body.action === 'pause' || body.action === 'resume') {
    if (typeof body.id !== 'string' || body.id === '' || !Number.isSafeInteger(body.revision) || (body.revision as number) < 1) {
      return { status: 400, body: { error: 'malformed' } }
    }
    context.controlGoal(body.action, body.id, body.revision as number)
    text = body.action === 'pause' ? 'Goal paused.' : 'Goal resumed.'
  } else if (body.action === 'enter-plan' || body.action === 'leave-plan') {
    context.controlPlan(body.action === 'enter-plan')
    text = body.action === 'enter-plan' ? 'Plan Mode enabled.' : 'Plan Mode disabled.'
  } else if (body.action === 'answer-question') {
    if (typeof body.id !== 'string' || body.id === '' || typeof body.selected !== 'string' || body.selected === ''
      || (body.custom !== undefined && typeof body.custom !== 'string')) {
      return { status: 400, body: { error: 'malformed' } }
    }
    context.answerQuestion(body.id, body.selected, body.custom)
    text = 'Answer submitted.'
  } else {
    return { status: 400, body: { error: 'malformed' } }
  }
  return {
    status: 200,
    body: context.project({ text }),
    broadcast: true,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
