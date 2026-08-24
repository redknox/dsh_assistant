import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { readProductVersion } from './compatibility.js'
import { isSafeRuntimePid, processAlive, type ProductHomeLayout } from './home.js'

export const RUNTIME_LEASE_SCHEMA_VERSION = 1

export interface RuntimeIdentity {
  readonly schemaVersion: number
  readonly pid: number
  readonly runId: string
  readonly startedAt: string
  readonly productVersion: string
  readonly normalizedHome: string
  readonly controlEndpoint?: string
  readonly profile?: string
  readonly profileIdentity?: string
  readonly workspaceIdentity?: string
  readonly sessionRootIdentity?: string
  readonly sessionId?: string
}

export interface RuntimeLeaseStamp {
  readonly profile?: string
  readonly profileIdentity?: string
  readonly workspaceIdentity?: string
  readonly sessionRootIdentity?: string
  readonly sessionId?: string
}

export type PublicRuntimeIdentity = Omit<RuntimeIdentity, 'runId'>

export interface RuntimeLeaseHold {
  readonly identity: RuntimeIdentity
  publishControlEndpoint(url: string): boolean
  release(): boolean
}

export type RuntimeLeaseAcquire =
  | { readonly ok: true; readonly hold: RuntimeLeaseHold }
  | { readonly ok: false; readonly error: 'home-busy' | 'home-ambiguous'; readonly detail: string }

export type RuntimeLeaseInspection =
  | { readonly state: 'empty' }
  | { readonly state: 'held'; readonly identity: PublicRuntimeIdentity }
  | { readonly state: 'stale'; readonly identity: PublicRuntimeIdentity }
  | { readonly state: 'ambiguous'; readonly identity?: PublicRuntimeIdentity; readonly detail: string }

const HOME_BUSY = 'TARS-NG home is already owned by a verified runtime. A TARS-NG Home has at most one verified writer.'
const HOME_AMBIGUOUS = 'A PID is alive but TARS-NG identity cannot be verified. A PID is liveness metadata, not process identity.'
export const HOME_AMBIGUOUS_RECOVERY = 'Refusing automatic takeover. Locate any live tars-ng process for this Home with tars-ng status, tars-ng doctor, and the OS, then stop that process. Do not delete state/runtime.lock while identity is unverified. A later start may reclaim only a proven-dead lease. Do not copy identity.json between Homes.'

const localHolds = new Map<string, string>()

export function ownsLocalRuntimeLease(layout: ProductHomeLayout): boolean {
  const runId = localHolds.get(layout.root)
  if (runId === undefined) return false
  const identity = readRuntimeIdentity(layout)
  return identity !== undefined && runIdEquals(identity.runId, runId)
}

export function publicRuntimeIdentity(identity: RuntimeIdentity): PublicRuntimeIdentity {
  return {
    schemaVersion: identity.schemaVersion,
    pid: identity.pid,
    startedAt: identity.startedAt,
    productVersion: identity.productVersion,
    normalizedHome: identity.normalizedHome,
    ...(identity.controlEndpoint ? { controlEndpoint: identity.controlEndpoint } : {}),
    ...(identity.profile ? { profile: identity.profile } : {}),
    ...(identity.profileIdentity ? { profileIdentity: identity.profileIdentity } : {}),
    ...(identity.workspaceIdentity ? { workspaceIdentity: identity.workspaceIdentity } : {}),
    ...(identity.sessionRootIdentity ? { sessionRootIdentity: identity.sessionRootIdentity } : {}),
    ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
  }
}

export async function inspectRuntimeLease(layout: ProductHomeLayout): Promise<RuntimeLeaseInspection> {
  if (!existsSync(layout.runtimeLockDir)) return { state: 'empty' }
  const parsed = parseRuntimeIdentityFile(layout)
  if (!parsed) {
    return { state: 'ambiguous', detail: `runtime lock directory exists without a readable identity record. ${HOME_AMBIGUOUS_RECOVERY}` }
  }
  if (parsed.normalizedHome !== layout.root) {
    return { state: 'ambiguous', detail: `identity.normalizedHome does not match this Home. ${HOME_AMBIGUOUS_RECOVERY}` }
  }
  const published = publicRuntimeIdentity(parsed)
  const verdict = await classifyOwner(parsed, layout)
  if (verdict === 'live') return { state: 'held', identity: published }
  if (verdict === 'dead') return { state: 'stale', identity: published }
  return { state: 'ambiguous', identity: published, detail: `${HOME_AMBIGUOUS} ${HOME_AMBIGUOUS_RECOVERY}` }
}

export async function acquireRuntimeLease(layout: ProductHomeLayout, stamp?: RuntimeLeaseStamp): Promise<RuntimeLeaseAcquire> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      mkdirSync(layout.runtimeLockDir, { recursive: false, mode: 0o700 })
      try {
        chmodSync(layout.runtimeLockDir, 0o700)
      } catch {
        // chmod may fail on some filesystems
      }
      const identity = writeNewRuntimeIdentity(layout, stamp)
      return { ok: true, hold: holdOf(layout, identity) }
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
      const current = readRuntimeIdentity(layout)
      if (!current) {
        await delay(20)
        continue
      }
      const verdict = await classifyOwner(current, layout)
      if (verdict === 'dead') {
        removeLeaseIfRunId(layout, current.runId)
        continue
      }
      if (verdict === 'live') {
        return { ok: false, error: 'home-busy', detail: `${HOME_BUSY} pid=${current.pid}` }
      }
      return { ok: false, error: 'home-ambiguous', detail: `${HOME_AMBIGUOUS} pid=${current.pid} ${HOME_AMBIGUOUS_RECOVERY}` }
    }
  }
  return { ok: false, error: 'home-ambiguous', detail: `${HOME_AMBIGUOUS} ${HOME_AMBIGUOUS_RECOVERY}` }
}

export function removeLeaseIfRunId(layout: ProductHomeLayout, runId: string): boolean {
  const current = readRuntimeIdentity(layout)
  if (!current || !runIdEquals(current.runId, runId)) return false
  const tomb = path.join(layout.state, `runtime.lock.${runId}.retired`)
  try {
    renameSync(layout.runtimeLockDir, tomb)
  } catch {
    return false
  }
  let moved: RuntimeIdentity | undefined
  try {
    moved = JSON.parse(readFileSync(path.join(tomb, 'identity.json'), 'utf8')) as RuntimeIdentity
  } catch {
    moved = undefined
  }
  if (!moved || !runIdEquals(moved.runId, runId)) {
    try {
      renameSync(tomb, layout.runtimeLockDir)
    } catch {
      // another writer may already own the live path
    }
    return false
  }
  rmSync(tomb, { recursive: true, force: true })
  return true
}

export function readRuntimeIdentity(layout: ProductHomeLayout): RuntimeIdentity | undefined {
  const parsed = parseRuntimeIdentityFile(layout)
  if (!parsed || parsed.normalizedHome !== layout.root) return undefined
  return parsed
}

function parseRuntimeIdentityFile(layout: ProductHomeLayout): RuntimeIdentity | undefined {
  if (!existsSync(layout.runtimeIdentityFile)) return undefined
  try {
    const raw = JSON.parse(readFileSync(layout.runtimeIdentityFile, 'utf8')) as Partial<RuntimeIdentity>
    if (raw.schemaVersion !== RUNTIME_LEASE_SCHEMA_VERSION) return undefined
    const pid = raw.pid
    if (!isSafeRuntimePid(pid) || typeof raw.runId !== 'string' || raw.runId.length < 32) return undefined
    if (typeof raw.startedAt !== 'string' || typeof raw.productVersion !== 'string' || typeof raw.normalizedHome !== 'string') {
      return undefined
    }
    return {
      schemaVersion: RUNTIME_LEASE_SCHEMA_VERSION,
      pid,
      runId: raw.runId,
      startedAt: raw.startedAt,
      productVersion: raw.productVersion,
      normalizedHome: raw.normalizedHome,
      ...(typeof raw.controlEndpoint === 'string' ? { controlEndpoint: raw.controlEndpoint } : {}),
      ...(typeof raw.profile === 'string' ? { profile: raw.profile } : {}),
      ...(typeof raw.profileIdentity === 'string' ? { profileIdentity: raw.profileIdentity } : {}),
      ...(typeof raw.workspaceIdentity === 'string' ? { workspaceIdentity: raw.workspaceIdentity } : {}),
      ...(typeof raw.sessionRootIdentity === 'string' ? { sessionRootIdentity: raw.sessionRootIdentity } : {}),
      ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
    }
  } catch {
    return undefined
  }
}

export function isLoopbackControlEndpoint(url: string): boolean {
  return normalizeLoopbackControlEndpoint(url) !== undefined
}

export function normalizeLoopbackControlEndpoint(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    if (parsed.username !== '' || parsed.password !== '') return undefined
    if (parsed.search !== '' || parsed.hash !== '') return undefined
    if (parsed.pathname !== '/' && parsed.pathname !== '') return undefined
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return undefined
    return parsed.origin
  } catch {
    return undefined
  }
}

export function runtimeHealthUrl(controlEndpoint: string): string {
  const origin = normalizeLoopbackControlEndpoint(controlEndpoint) ?? controlEndpoint
  return new URL('/api/runtime-health', origin.endsWith('/') ? origin : `${origin}/`).href
}

export function runtimeStopUrl(controlEndpoint: string): string {
  const origin = normalizeLoopbackControlEndpoint(controlEndpoint) ?? controlEndpoint
  return new URL('/api/runtime-stop', origin.endsWith('/') ? origin : `${origin}/`).href
}

export function runIdEquals(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function challengeRuntimeIdentity(identity: RuntimeIdentity, expectedHome = identity.normalizedHome): Promise<boolean> {
  if (!isSafeRuntimePid(identity.pid) || identity.normalizedHome !== expectedHome) return false
  if (identity.controlEndpoint === undefined || !isLoopbackControlEndpoint(identity.controlEndpoint)) return false
  try {
    const response = await fetch(runtimeHealthUrl(identity.controlEndpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: identity.runId }),
      signal: AbortSignal.timeout(500),
    })
    if (!response.ok) return false
    const body = await response.json() as { pid?: unknown; startedAt?: unknown; productVersion?: unknown; normalizedHome?: unknown }
    return body.pid === identity.pid
      && body.startedAt === identity.startedAt
      && body.productVersion === identity.productVersion
      && body.normalizedHome === identity.normalizedHome
      && body.normalizedHome === expectedHome
  } catch {
    return false
  }
}

async function classifyOwner(identity: RuntimeIdentity, layout: ProductHomeLayout): Promise<'live' | 'dead' | 'ambiguous'> {
  if (identity.normalizedHome !== layout.root) return 'ambiguous'
  if (!isSafeRuntimePid(identity.pid) || !processAlive(identity.pid)) return 'dead'
  const localRunId = localHolds.get(layout.root)
  if (localRunId !== undefined && runIdEquals(localRunId, identity.runId)) return 'live'
  return await challengeRuntimeIdentity(identity, layout.root) ? 'live' : 'ambiguous'
}

export function writeNewRuntimeIdentity(layout: ProductHomeLayout, stamp?: RuntimeLeaseStamp): RuntimeIdentity {
  const identity: RuntimeIdentity = {
    schemaVersion: RUNTIME_LEASE_SCHEMA_VERSION,
    pid: process.pid,
    runId: randomBytes(32).toString('hex'),
    startedAt: new Date().toISOString(),
    productVersion: readProductVersion(),
    normalizedHome: layout.root,
    ...(stamp?.profile ? { profile: stamp.profile } : {}),
    ...(stamp?.profileIdentity ? { profileIdentity: stamp.profileIdentity } : {}),
    ...(stamp?.workspaceIdentity ? { workspaceIdentity: stamp.workspaceIdentity } : {}),
    ...(stamp?.sessionRootIdentity ? { sessionRootIdentity: stamp.sessionRootIdentity } : {}),
    ...(stamp?.sessionId ? { sessionId: stamp.sessionId } : {}),
  }
  try {
    writeIdentity(layout, identity)
    return identity
  } catch (error) {
    rmSync(layout.runtimeLockDir, { recursive: true, force: true })
    throw error
  }
}

function writeIdentity(layout: ProductHomeLayout, identity: RuntimeIdentity): void {
  const tmp = path.join(layout.runtimeLockDir, `.identity.${process.pid}.${randomBytes(8).toString('hex')}.tmp`)
  writeFileSync(tmp, `${JSON.stringify(identity)}\n`, { mode: 0o600 })
  try {
    const fd = openSync(tmp, 'r+')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try {
      chmodSync(tmp, 0o600)
    } catch {
      // chmod may fail on some filesystems
    }
    renameSync(tmp, layout.runtimeIdentityFile)
    try {
      const dirFd = openSync(layout.runtimeLockDir, 'r')
      try {
        fsyncSync(dirFd)
      } finally {
        closeSync(dirFd)
      }
    } catch {
      // directory fsync is best-effort
    }
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // temp file may already be gone
    }
    throw error
  }
}

function rememberLocalHold(identity: RuntimeIdentity): void {
  localHolds.set(identity.normalizedHome, identity.runId)
}

function forgetLocalHold(identity: RuntimeIdentity): void {
  const current = localHolds.get(identity.normalizedHome)
  if (current !== undefined && runIdEquals(current, identity.runId)) {
    localHolds.delete(identity.normalizedHome)
  }
}

function holdOf(layout: ProductHomeLayout, identity: RuntimeIdentity): RuntimeLeaseHold {
  let current = identity
  rememberLocalHold(current)
  return {
    get identity() {
      return current
    },
    publishControlEndpoint(url: string) {
      const endpoint = normalizeLoopbackControlEndpoint(url)
      if (endpoint === undefined) return false
      const latest = readRuntimeIdentity(layout)
      if (!latest || !runIdEquals(latest.runId, current.runId) || latest.normalizedHome !== layout.root) return false
      current = { ...latest, controlEndpoint: endpoint }
      writeIdentity(layout, current)
      return true
    },
    release() {
      forgetLocalHold(current)
      return removeLeaseIfRunId(layout, current.runId)
    },
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST'
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
