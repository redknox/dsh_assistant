import { DEFAULT_UI_HOST, DEFAULT_UI_PORT } from './constants.js'
import type { MissionControlView } from '../domain/workspace/types.js'

export const SUPPORTED_RECOVERY_ACTIONS = ['diagnostics', 'rollback', 'restart-normally'] as const
export type SupportedRecoveryAction = (typeof SUPPORTED_RECOVERY_ACTIONS)[number]

export interface WebUiListenOptions {
  readonly host?: string
  readonly port?: number
}

export interface WebUiEnvelope {
  readonly view: MissionControlView
  readonly webUi: string
}

export function resolveWebUiListen(env: NodeJS.ProcessEnv = process.env, overrides: WebUiListenOptions = {}): { host: string; port: number } {
  const host = overrides.host ?? (typeof env.TARS_NG_UI_HOST === 'string' && env.TARS_NG_UI_HOST !== '' ? env.TARS_NG_UI_HOST : DEFAULT_UI_HOST)
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(`Web UI refuses to bind ${host}; loopback only (127.0.0.1 / localhost / ::1)`)
  }
  const raw = overrides.port ?? (env.TARS_NG_UI_PORT === undefined || env.TARS_NG_UI_PORT === '' ? DEFAULT_UI_PORT : Number(env.TARS_NG_UI_PORT))
  if (!Number.isInteger(raw) || raw < 0 || raw > 65535) {
    throw new Error(`invalid TARS_NG_UI_PORT ${String(env.TARS_NG_UI_PORT)}`)
  }
  return { host: host === 'localhost' ? '127.0.0.1' : host, port: raw }
}

export function originAllowed(origin: string | undefined, host: string, port: number): boolean {
  if (origin === undefined || origin === '') return true
  try {
    const url = new URL(origin)
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
    if (!loopback || (url.protocol !== 'http:' && url.protocol !== 'ws:')) return false
    const originPort = url.port === '' ? 80 : Number(url.port)
    return originPort === port || (host === '::1' && originPort === port)
  } catch {
    return false
  }
}

export function payloadContainsSecret(payload: string, env: NodeJS.ProcessEnv = process.env): boolean {
  for (const name of ['DEEPSEEK_API_KEY', 'DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN', 'GOOGLE_SEARCH_API_KEY'] as const) {
    const value = env[name]
    if (typeof value === 'string' && value.length >= 8 && payload.includes(value)) return true
  }
  return false
}

export function assertSafePayload(payload: string, env: NodeJS.ProcessEnv = process.env): string {
  if (payloadContainsSecret(payload, env)) {
    throw new Error('refusing to emit a UI payload that contains a secret value')
  }
  if (/"type"\s*:\s*"reasoning"|reasoning_content/.test(payload)) {
    throw new Error('refusing to emit a UI payload that contains hidden reasoning')
  }
  return payload
}
