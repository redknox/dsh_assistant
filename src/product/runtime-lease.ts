import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { readProductVersion } from './compatibility.js'
import { processAlive, type ProductHomeLayout } from './home.js'

export const RUNTIME_LEASE_SCHEMA_VERSION = 1

export interface RuntimeIdentity {
  readonly schemaVersion: number
  readonly pid: number
  readonly runId: string
  readonly startedAt: string
  readonly productVersion: string
  readonly normalizedHome: string
  readonly controlEndpoint?: string
}

export type PublicRuntimeIdentity = Omit<RuntimeIdentity, 'runId'>

export interface RuntimeLeaseHold {
  readonly identity: RuntimeIdentity
  publishControlEndpoint(url: string): void
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
const HOME_AMBIGUOUS = 'A PID is alive but TARS-NG identity cannot be verified. A PID is liveness metadata, not process identity. Refusing automatic takeover.'

export function publicRuntimeIdentity(identity: RuntimeIdentity): PublicRuntimeIdentity {
  return {
    schemaVersion: identity.schemaVersion,
    pid: identity.pid,
    startedAt: identity.startedAt,
    productVersion: identity.productVersion,
    normalizedHome: identity.normalizedHome,
    ...(identity.controlEndpoint ? { controlEndpoint: identity.controlEndpoint } : {}),
  }
}

export async function inspectRuntimeLease(layout: ProductHomeLayout): Promise<RuntimeLeaseInspection> {
  if (!existsSync(layout.runtimeLockDir)) return { state: 'empty' }
  const identity = readRuntimeIdentity(layout)
  if (!identity) {
    return { state: 'ambiguous', detail: 'runtime lock directory exists without a readable identity record' }
  }
  const published = publicRuntimeIdentity(identity)
  const verdict = await classifyOwner(identity)
  if (verdict === 'live') return { state: 'held', identity: published }
  if (verdict === 'dead') return { state: 'stale', identity: published }
  return { state: 'ambiguous', identity: published, detail: HOME_AMBIGUOUS }
}

export async function acquireRuntimeLease(layout: ProductHomeLayout): Promise<RuntimeLeaseAcquire> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      mkdirSync(layout.runtimeLockDir, { recursive: false, mode: 0o700 })
      try {
        chmodSync(layout.runtimeLockDir, 0o700)
      } catch {
        // chmod may fail on some filesystems
      }
      const identity = writeNewIdentity(layout)
      return { ok: true, hold: holdOf(layout, identity) }
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
      const current = readRuntimeIdentity(layout)
      if (!current) {
        await delay(20)
        continue
      }
      const verdict = await classifyOwner(current)
      if (verdict === 'dead') {
        removeLeaseIfRunId(layout, current.runId)
        continue
      }
      if (verdict === 'live') {
        return { ok: false, error: 'home-busy', detail: `${HOME_BUSY} pid=${current.pid}` }
      }
      return { ok: false, error: 'home-ambiguous', detail: `${HOME_AMBIGUOUS} pid=${current.pid}` }
    }
  }
  return { ok: false, error: 'home-ambiguous', detail: HOME_AMBIGUOUS }
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
  if (!existsSync(layout.runtimeIdentityFile)) return undefined
  try {
    const raw = JSON.parse(readFileSync(layout.runtimeIdentityFile, 'utf8')) as Partial<RuntimeIdentity>
    if (raw.schemaVersion !== RUNTIME_LEASE_SCHEMA_VERSION) return undefined
    const pid = raw.pid
    if (typeof pid !== 'number' || !Number.isInteger(pid) || typeof raw.runId !== 'string' || raw.runId.length < 32) return undefined
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
    }
  } catch {
    return undefined
  }
}

export function runtimeHealthUrl(controlEndpoint: string): string {
  return new URL('/api/runtime-health', controlEndpoint.endsWith('/') ? controlEndpoint : `${controlEndpoint}/`).href
}

export function runtimeStopUrl(controlEndpoint: string): string {
  return new URL('/api/runtime-stop', controlEndpoint.endsWith('/') ? controlEndpoint : `${controlEndpoint}/`).href
}

export function runIdEquals(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

async function classifyOwner(identity: RuntimeIdentity): Promise<'live' | 'dead' | 'ambiguous'> {
  if (!processAlive(identity.pid)) return 'dead'
  if (identity.pid === process.pid) return 'live'
  if (identity.controlEndpoint === undefined) return 'ambiguous'
  try {
    const response = await fetch(runtimeHealthUrl(identity.controlEndpoint), {
      signal: AbortSignal.timeout(500),
    })
    if (!response.ok) return 'ambiguous'
    const body = await response.json() as { pid?: unknown; productVersion?: unknown }
    if (body.pid === identity.pid && body.productVersion === identity.productVersion) return 'live'
    return 'ambiguous'
  } catch {
    return 'ambiguous'
  }
}

function writeNewIdentity(layout: ProductHomeLayout): RuntimeIdentity {
  const identity: RuntimeIdentity = {
    schemaVersion: RUNTIME_LEASE_SCHEMA_VERSION,
    pid: process.pid,
    runId: randomBytes(32).toString('hex'),
    startedAt: new Date().toISOString(),
    productVersion: readProductVersion(),
    normalizedHome: layout.root,
  }
  writeIdentity(layout, identity)
  return identity
}

function writeIdentity(layout: ProductHomeLayout, identity: RuntimeIdentity): void {
  writeFileSync(layout.runtimeIdentityFile, `${JSON.stringify(identity)}\n`, { mode: 0o600 })
  try {
    chmodSync(layout.runtimeIdentityFile, 0o600)
  } catch {
    // chmod may fail on some filesystems
  }
}

function holdOf(layout: ProductHomeLayout, identity: RuntimeIdentity): RuntimeLeaseHold {
  let current = identity
  return {
    get identity() {
      return current
    },
    publishControlEndpoint(url: string) {
      const latest = readRuntimeIdentity(layout)
      if (!latest || !runIdEquals(latest.runId, current.runId)) return
      current = { ...latest, controlEndpoint: url }
      writeIdentity(layout, current)
    },
    release() {
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
