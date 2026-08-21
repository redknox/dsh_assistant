import { randomBytes, timingSafeEqual } from 'node:crypto'
import { DEFAULT_UI_HOST, DEFAULT_UI_PORT } from './constants.js'
import type { MissionControlView } from '../domain/workspace/types.js'

export const UI_SESSION_COOKIE = 'tars_ng_ui'
export const SUPPORTED_RECOVERY_ACTIONS = ['diagnostics', 'rollback', 'exit-safe-mode'] as const
export type SupportedRecoveryAction = (typeof SUPPORTED_RECOVERY_ACTIONS)[number]
export const DESTRUCTIVE_RECOVERY_ACTIONS = ['rollback', 'exit-safe-mode'] as const

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

export function createUiSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

export function sessionCookieHeader(token: string): string {
  return `${UI_SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`
}

export function readCookie(header: string | undefined, name = UI_SESSION_COOKIE): string | undefined {
  if (header === undefined || header === '') return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return undefined
}

export function sessionMatches(header: string | undefined, token: string): boolean {
  const got = readCookie(header)
  if (got === undefined || got.length !== token.length) return false
  return timingSafeEqual(Buffer.from(got), Buffer.from(token))
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
