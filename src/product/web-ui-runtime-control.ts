import type { OperatorStatus } from '../domain/self-extension/status.js'
import { runIdEquals } from './runtime-lease.js'

export interface WebUiRuntimeControl {
  readonly pid: number
  readonly startedAt: string
  readonly productVersion: string
  readonly normalizedHome: string
  readonly runId: string
  readonly onStop: () => void
  readonly inspectLive?: () => {
    readonly safeMode: boolean
    readonly recoveryRequired: boolean
    readonly persistence?: string
    readonly operator?: OperatorStatus
    readonly skills?: {
      readonly profile: string
      readonly candidates: number
      readonly active: readonly string[]
      readonly disabled: readonly string[]
      readonly failed: readonly string[]
      readonly catalog: 'ok' | 'empty' | 'degraded' | 'withheld'
      readonly recoveryRequired?: boolean
      readonly catalogDetail?: string
    }
  }
}

export interface RuntimeControlRequest {
  readonly method?: string
  readonly pathname: string
  readonly readJson: () => Promise<unknown>
}

export interface RuntimeControlResponse {
  readonly status: number
  readonly body: unknown
  readonly afterSend?: () => void
}

export async function handleRuntimeControlRequest(
  request: RuntimeControlRequest,
  control?: WebUiRuntimeControl,
): Promise<RuntimeControlResponse | undefined> {
  const health = (request.method === 'GET' || request.method === 'POST')
    && request.pathname === '/api/runtime-health'
  const stop = request.method === 'POST' && request.pathname === '/api/runtime-stop'
  if (!health && !stop) return undefined
  if (!control) return { status: 404, body: { error: 'runtime-control-unavailable' } }

  if (request.method === 'POST') {
    const body = await request.readJson()
    const runId = body && typeof body === 'object' && 'runId' in body
      ? (body as { readonly runId?: unknown }).runId
      : undefined
    if (typeof runId !== 'string' || !runIdEquals(runId, control.runId)) {
      return { status: 403, body: { error: 'identity-mismatch' } }
    }
  }

  if (stop) {
    return {
      status: 200,
      body: { ok: true, pid: control.pid },
      afterSend: control.onStop,
    }
  }

  const publicHealth = {
    pid: control.pid,
    startedAt: control.startedAt,
    productVersion: control.productVersion,
  }
  return {
    status: 200,
    body: request.method === 'POST'
      ? { ...publicHealth, normalizedHome: control.normalizedHome, ...(control.inspectLive ? control.inspectLive() : {}) }
      : publicHealth,
  }
}
