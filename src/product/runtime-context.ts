import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { PRODUCT_CONFIG_SCHEMA_VERSION } from './constants.js'
import { isSafeRuntimePid, processAlive, type ProductHomeLayout } from './home.js'
import { runIdEquals } from './runtime-lease.js'
import { profileIdentityOf, tryLoadGovernedAssistantComposition } from './profile-load.js'

export const RUNTIME_CONTEXT_SCHEMA_VERSION = 1
export const DEFAULT_PROFILE_NAME = 'assistant'
export const DEFAULT_SESSION_ID = 'main'
export const KNOWN_PROFILES = Object.freeze([DEFAULT_PROFILE_NAME] as const)

export type ConfigSource = 'cli' | 'environment' | 'product-config' | 'default'

export class RuntimeContextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeContextError'
  }
}

export interface RuntimeField<T> {
  readonly value: T
  readonly source: ConfigSource
}

export interface RuntimeContext {
  readonly schemaVersion: number
  readonly home: string
  readonly profile: RuntimeField<string>
  readonly profileIdentity: string
  readonly workspace: RuntimeField<string>
  readonly workspaceIdentity: string
  readonly workspaceLabel: string
  readonly sessionRoot: RuntimeField<string>
  readonly sessionRootIdentity: string
  readonly sessionId: RuntimeField<string>
  readonly sessionPersistenceDir: string
  readonly safeMode: boolean
  readonly migrated: boolean
  readonly profileCompositionError?: string
}

export interface RuntimeBinding {
  readonly schemaVersion: number
  readonly home: string
  readonly profile: string
  readonly profileIdentity: string
  readonly workspace: string
  readonly workspaceIdentity: string
  readonly sessionRoot: string
  readonly sessionRootIdentity: string
}

export interface RuntimeSelection {
  readonly profile?: string
  readonly workspace?: string
  readonly sessionRoot?: string
  readonly sessionId?: string
}

export interface ProductRuntimeConfig {
  readonly schemaVersion: number
  readonly profile?: string
  readonly workspace?: string
  readonly sessionRoot?: string
  readonly sessionId?: string
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const PROFILE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

export function runtimeContextBindingFile(layout: ProductHomeLayout): string {
  return path.join(layout.state, 'runtime-context.json')
}

export function defaultWorkspaceDir(home: string): string {
  return path.join(home, 'workspace')
}

export function defaultSessionRootDir(home: string): string {
  return path.join(home, 'sessions')
}

export function stableIdentity(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

export function workspaceLabelOf(workspace: string): string {
  return path.basename(workspace) || 'workspace'
}

function firstDefined(values: readonly (string | undefined)[]): string | undefined {
  return values.find((item) => item !== undefined)
}

function pickField(cli?: string, env?: string, file?: string, fallback?: string): RuntimeField<string> {
  if (cli !== undefined) return { value: cli, source: 'cli' }
  if (env !== undefined) return { value: env, source: 'environment' }
  if (file !== undefined) return { value: file, source: 'product-config' }
  if (fallback !== undefined) return { value: fallback, source: 'default' }
  throw new RuntimeContextError('runtime context is missing a required value')
}

export function parseSessionId(value: string): string {
  if (!SESSION_ID_PATTERN.test(value) || value.includes('..') || value.includes('/') || value.includes('\\')) {
    throw new RuntimeContextError('invalid session id')
  }
  return value
}

export function parseProfileName(value: string): string {
  if (!PROFILE_PATTERN.test(value) || !(KNOWN_PROFILES as readonly string[]).includes(value)) {
    throw new RuntimeContextError('unknown or invalid profile')
  }
  return value
}

function envText(name: string): string | undefined {
  const value = process.env[name]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function assertSafePath(value: string, kind: 'workspace' | 'session-root'): string {
  const absolute = path.resolve(value)
  if (absolute.includes(`${path.sep}..${path.sep}`) || path.basename(value) === '..') {
    throw new RuntimeContextError(`${kind} path is invalid`)
  }
  return absolute
}

function inspectDir(value: string, kind: 'workspace' | 'session-root', required: boolean): string {
  const absolute = assertSafePath(value, kind)
  if (!existsSync(absolute)) {
    if (required) throw new RuntimeContextError(`${kind} must be an existing directory`)
    return absolute
  }
  let resolved: string
  try {
    resolved = realpathSync(absolute)
  } catch {
    throw new RuntimeContextError(`${kind} could not be resolved`)
  }
  if (!statSync(resolved).isDirectory()) throw new RuntimeContextError(`${kind} must be a directory`)
  return resolved
}

function createOwnedDir(dir: string): string {
  const existed = existsSync(dir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!existed) {
    try {
      chmodSync(dir, 0o700)
    } catch {
      // chmod may fail on some filesystems
    }
  }
  return realpathSync(dir)
}

function writeJsonAtomic(file: string, body: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
  const fd = openSync(tmp, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
}

export function readProductRuntimeConfig(raw: unknown): ProductRuntimeConfig | undefined {
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined
  const runtime = (raw as { runtime?: unknown }).runtime
  if (runtime === undefined) return undefined
  if (runtime === null || typeof runtime !== 'object') throw new RuntimeContextError('invalid product runtime section')
  const record = runtime as { schemaVersion?: unknown; profile?: unknown; workspace?: unknown; sessionRoot?: unknown; sessionId?: unknown }
  const schemaVersion = typeof record.schemaVersion === 'number' ? record.schemaVersion : RUNTIME_CONTEXT_SCHEMA_VERSION
  if (schemaVersion > RUNTIME_CONTEXT_SCHEMA_VERSION) {
    throw new RuntimeContextError(`unsupported runtime context schema ${schemaVersion}`)
  }
  return {
    schemaVersion,
    ...(typeof record.profile === 'string' ? { profile: record.profile } : {}),
    ...(typeof record.workspace === 'string' ? { workspace: record.workspace } : {}),
    ...(typeof record.sessionRoot === 'string' ? { sessionRoot: record.sessionRoot } : {}),
    ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
  }
}

export function readRuntimeBinding(layout: ProductHomeLayout): RuntimeBinding | undefined {
  const file = runtimeContextBindingFile(layout)
  if (!existsSync(file)) return undefined
  const raw = JSON.parse(readFileSync(file, 'utf8')) as {
    schemaVersion?: unknown
    home?: unknown
    profile?: unknown
    profileIdentity?: unknown
    workspace?: unknown
    workspaceIdentity?: unknown
    sessionRoot?: unknown
    sessionRootIdentity?: unknown
  }
  if (typeof raw.schemaVersion === 'number' && raw.schemaVersion > RUNTIME_CONTEXT_SCHEMA_VERSION) {
    throw new RuntimeContextError(`unsupported runtime context schema ${raw.schemaVersion}`)
  }
  if (
    typeof raw.home !== 'string'
    || typeof raw.profile !== 'string'
    || typeof raw.profileIdentity !== 'string'
    || typeof raw.workspace !== 'string'
    || typeof raw.workspaceIdentity !== 'string'
    || typeof raw.sessionRoot !== 'string'
    || typeof raw.sessionRootIdentity !== 'string'
  ) {
    throw new RuntimeContextError('runtime context binding is corrupt')
  }
  return {
    schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : RUNTIME_CONTEXT_SCHEMA_VERSION,
    home: raw.home,
    profile: raw.profile,
    profileIdentity: raw.profileIdentity,
    workspace: raw.workspace,
    workspaceIdentity: raw.workspaceIdentity,
    sessionRoot: raw.sessionRoot,
    sessionRootIdentity: raw.sessionRootIdentity,
  }
}

function writeRuntimeBinding(layout: ProductHomeLayout, binding: RuntimeBinding): void {
  writeJsonAtomic(runtimeContextBindingFile(layout), binding)
}

function backupBeforeMigration(layout: ProductHomeLayout): void {
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
  const dest = path.join(layout.backups, `runtime-context-${stamp}`)
  mkdirSync(dest, { recursive: true, mode: 0o700 })
  if (existsSync(layout.productConfigFile)) {
    copyFileSync(layout.productConfigFile, path.join(dest, 'product.json'))
  }
}

export function writeProductRuntimeSection(
  layout: ProductHomeLayout,
  allowFixtures: boolean,
  runtime: ProductRuntimeConfig,
): void {
  const body = {
    schemaVersion: PRODUCT_CONFIG_SCHEMA_VERSION,
    allowFixtures,
    runtime,
  }
  writeJsonAtomic(layout.productConfigFile, body)
}

export const SESSION_OWNER_SCHEMA_VERSION = 1

export interface SessionRootOwner {
  readonly schemaVersion: number
  readonly home: string
  readonly profileIdentity: string
  readonly workspaceIdentity: string
  readonly partitionKey: string
}

export interface SessionPartitionIdentity {
  readonly schemaVersion: number
  readonly pid: number
  readonly runId: string
  readonly startedAt: string
  readonly home: string
  readonly partitionKey: string
}

export interface SessionPartitionHold {
  readonly root: string
  readonly runId: string
  readonly createdOwner: boolean
  release(): boolean
}

export type SessionPartitionInspection =
  | { readonly state: 'empty' }
  | { readonly state: 'held'; readonly identity: SessionPartitionIdentity }
  | { readonly state: 'stale'; readonly identity: SessionPartitionIdentity }
  | { readonly state: 'ambiguous'; readonly detail: string }

export function partitionKeyOf(input: {
  readonly home: string
  readonly profileIdentity: string
  readonly workspaceIdentity: string
}): string {
  return stableIdentity(`${input.home}\n${input.profileIdentity}\n${input.workspaceIdentity}`)
}

export function sessionPersistenceDirOf(context: Pick<RuntimeContext, 'home' | 'profileIdentity' | 'workspaceIdentity' | 'sessionRoot'>): string {
  return path.join(context.sessionRoot.value, '.tars-ng-sessions', partitionKeyOf(context))
}

export function sessionRootOwnerFile(sessionRoot: string): string {
  return path.join(sessionRoot, '.tars-ng-session-owner.json')
}

export function readSessionRootOwner(sessionRoot: string): SessionRootOwner | undefined {
  const file = sessionRootOwnerFile(sessionRoot)
  if (!existsSync(file)) return undefined
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<SessionRootOwner>
  if (typeof raw.schemaVersion === 'number' && raw.schemaVersion > SESSION_OWNER_SCHEMA_VERSION) {
    throw new RuntimeContextError(`unsupported session-root owner schema ${raw.schemaVersion}`)
  }
  if (
    typeof raw.home !== 'string'
    || typeof raw.profileIdentity !== 'string'
    || typeof raw.workspaceIdentity !== 'string'
    || typeof raw.partitionKey !== 'string'
  ) {
    throw new RuntimeContextError('session-root owner stamp is corrupt')
  }
  return {
    schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : SESSION_OWNER_SCHEMA_VERSION,
    home: raw.home,
    profileIdentity: raw.profileIdentity,
    workspaceIdentity: raw.workspaceIdentity,
    partitionKey: raw.partitionKey,
  }
}

export function assertSessionRootOwner(
  sessionRoot: string,
  context: Pick<RuntimeContext, 'home' | 'profileIdentity' | 'workspaceIdentity'>,
): void {
  if (!existsSync(sessionRoot)) return
  const owner = readSessionRootOwner(sessionRoot)
  if (!owner) return
  const expected = partitionKeyOf(context)
  if (
    owner.home !== context.home
    || owner.profileIdentity !== context.profileIdentity
    || owner.workspaceIdentity !== context.workspaceIdentity
    || owner.partitionKey !== expected
  ) {
    throw new RuntimeContextError('session-root is bound to another Home/Profile/Workspace')
  }
}

export function stampSessionRootOwner(context: RuntimeContext): boolean {
  const sessionRoot = context.sessionRoot.value
  assertSessionRootOwner(sessionRoot, context)
  const existing = readSessionRootOwner(sessionRoot)
  if (existing) return false
  const stamp: SessionRootOwner = {
    schemaVersion: SESSION_OWNER_SCHEMA_VERSION,
    home: context.home,
    profileIdentity: context.profileIdentity,
    workspaceIdentity: context.workspaceIdentity,
    partitionKey: partitionKeyOf(context),
  }
  const file = sessionRootOwnerFile(sessionRoot)
  mkdirSync(sessionRoot, { recursive: true, mode: 0o700 })
  let created = false
  try {
    const fd = openSync(file, 'wx', 0o600)
    try {
      writeFileSync(fd, `${JSON.stringify(stamp, null, 2)}\n`)
      fsyncSync(fd)
      created = true
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  assertSessionRootOwner(sessionRoot, context)
  return created
}

export function rollbackSessionRootOwner(context: RuntimeContext): boolean {
  const owner = readSessionRootOwner(context.sessionRoot.value)
  if (!owner) return false
  if (
    owner.home !== context.home
    || owner.profileIdentity !== context.profileIdentity
    || owner.workspaceIdentity !== context.workspaceIdentity
    || owner.partitionKey !== partitionKeyOf(context)
  ) {
    return false
  }
  const partition = sessionPersistenceDirOf(context)
  if (existsSync(partition)) {
    const leftover = readdirSync(partition).filter((name) => !name.startsWith('.writer.lock'))
    if (leftover.length > 0) return false
  }
  try {
    unlinkSync(sessionRootOwnerFile(context.sessionRoot.value))
  } catch {
    return false
  }
  return true
}

export function sessionPartitionLockDir(root: string): string {
  return path.join(root, '.writer.lock')
}

export function readSessionPartitionIdentity(root: string): SessionPartitionIdentity | undefined {
  const file = path.join(sessionPartitionLockDir(root), 'identity.json')
  if (!existsSync(file)) return undefined
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<SessionPartitionIdentity>
    if (raw.schemaVersion !== SESSION_OWNER_SCHEMA_VERSION) return undefined
    if (!isSafeRuntimePid(raw.pid) || typeof raw.runId !== 'string' || raw.runId.length < 32) return undefined
    if (typeof raw.startedAt !== 'string' || typeof raw.home !== 'string' || typeof raw.partitionKey !== 'string') {
      return undefined
    }
    return {
      schemaVersion: SESSION_OWNER_SCHEMA_VERSION,
      pid: raw.pid,
      runId: raw.runId,
      startedAt: raw.startedAt,
      home: raw.home,
      partitionKey: raw.partitionKey,
    }
  } catch {
    return undefined
  }
}

export function inspectSessionPartition(root: string): SessionPartitionInspection {
  const lockDir = sessionPartitionLockDir(root)
  if (!existsSync(lockDir)) return { state: 'empty' }
  const identity = readSessionPartitionIdentity(root)
  if (!identity) {
    return { state: 'ambiguous', detail: 'session partition lock exists without a verifiable identity' }
  }
  if (!processAlive(identity.pid)) return { state: 'stale', identity }
  if (localPartitionHolds.get(root) !== undefined && runIdEquals(localPartitionHolds.get(root)!, identity.runId)) {
    return { state: 'held', identity }
  }
  return { state: 'ambiguous', detail: 'session partition lock belongs to a live unverified writer' }
}

export function sweepIncompletePartitionLocks(root: string): void {
  if (!existsSync(root)) return
  for (const name of readdirSync(root)) {
    const staged = /^\.writer\.lock\.([0-9a-f]{64})\.staging$/.exec(name)
    if (!staged) continue
    const dir = path.join(root, name)
    let identity: SessionPartitionIdentity | undefined
    try {
      const raw = JSON.parse(readFileSync(path.join(dir, 'identity.json'), 'utf8')) as Partial<SessionPartitionIdentity>
      if (typeof raw.pid === 'number' && typeof raw.runId === 'string') {
        identity = raw as SessionPartitionIdentity
      }
    } catch {
      identity = undefined
    }
    if (identity && processAlive(identity.pid)) continue
    rmSync(dir, { recursive: true, force: true })
  }
}

function publishPartitionLock(root: string, identity: SessionPartitionIdentity): void {
  const staging = path.join(root, `.writer.lock.${identity.runId}.staging`)
  mkdirSync(staging, { recursive: false, mode: 0o700 })
  try {
    writeJsonAtomic(path.join(staging, 'identity.json'), identity)
    try {
      const fd = openSync(staging, 'r')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    } catch {
      // directory fsync is best-effort
    }
    renameSync(staging, sessionPartitionLockDir(root))
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

export function removePartitionLockIfRunId(root: string, runId: string): boolean {
  const current = readSessionPartitionIdentity(root)
  if (!current || !runIdEquals(current.runId, runId)) return false
  const lockDir = sessionPartitionLockDir(root)
  const tomb = path.join(path.dirname(lockDir), `.writer.lock.${runId}.retired`)
  try {
    renameSync(lockDir, tomb)
    rmSync(tomb, { recursive: true, force: true })
  } catch {
    return false
  }
  if (localPartitionHolds.get(root) !== undefined && runIdEquals(localPartitionHolds.get(root)!, runId)) {
    localPartitionHolds.delete(root)
  }
  return true
}

const localPartitionHolds = new Map<string, string>()

export function claimSessionPartition(context: RuntimeContext): SessionPartitionHold {
  const existedOwner = readSessionRootOwner(context.sessionRoot.value) !== undefined
  let createdOwner = false
  try {
    createdOwner = stampSessionRootOwner(context) && !existedOwner
    const root = sessionPersistenceDirOf(context)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    try {
      chmodSync(root, 0o700)
    } catch {
      // chmod may fail on some filesystems
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      sweepIncompletePartitionLocks(root)
      const inspected = inspectSessionPartition(root)
      if (inspected.state === 'held') {
        throw new RuntimeContextError('session partition is already held by another writer')
      }
      if (inspected.state === 'ambiguous') {
        throw new RuntimeContextError(`session-partition-ambiguous: ${inspected.detail}`)
      }
      if (inspected.state === 'stale') {
        removePartitionLockIfRunId(root, inspected.identity.runId)
        continue
      }
      const identity: SessionPartitionIdentity = {
        schemaVersion: SESSION_OWNER_SCHEMA_VERSION,
        pid: process.pid,
        runId: randomBytes(32).toString('hex'),
        startedAt: new Date().toISOString(),
        home: context.home,
        partitionKey: partitionKeyOf(context),
      }
      try {
        publishPartitionLock(root, identity)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        continue
      }
      localPartitionHolds.set(root, identity.runId)
      return {
        root,
        runId: identity.runId,
        createdOwner,
        release() {
          return removePartitionLockIfRunId(root, identity.runId)
        },
      }
    }
    throw new RuntimeContextError('session-partition-ambiguous: could not acquire a verified writer lock')
  } catch (error) {
    if (createdOwner) rollbackSessionRootOwner(context)
    throw error
  }
}

function contextFromResolved(
  layout: ProductHomeLayout,
  profile: RuntimeField<string>,
  workspace: RuntimeField<string>,
  sessionRoot: RuntimeField<string>,
  sessionId: RuntimeField<string>,
  resolvedWorkspace: string,
  resolvedSessionRoot: string,
  options: {
    readonly safeMode?: boolean
    readonly migrated: boolean
    readonly profileIdentity: string
    readonly profileCompositionError?: string
  },
): RuntimeContext {
  const workspaceIdentity = stableIdentity(resolvedWorkspace)
  const sessionRootIdentity = stableIdentity(resolvedSessionRoot)
  const assembled = {
    schemaVersion: RUNTIME_CONTEXT_SCHEMA_VERSION,
    home: layout.root,
    profile,
    profileIdentity: options.profileIdentity,
    workspace: { ...workspace, value: resolvedWorkspace },
    workspaceIdentity,
    workspaceLabel: workspaceLabelOf(resolvedWorkspace),
    sessionRoot: { ...sessionRoot, value: resolvedSessionRoot },
    sessionRootIdentity,
    sessionId,
    sessionPersistenceDir: '',
    safeMode: options.safeMode === true,
    migrated: options.migrated,
    ...(options.profileCompositionError === undefined ? {} : { profileCompositionError: options.profileCompositionError }),
  }
  return { ...assembled, sessionPersistenceDir: sessionPersistenceDirOf(assembled) }
}

export function inspectRuntimeContext(
  layout: ProductHomeLayout,
  selection: RuntimeSelection,
  fileRuntime: ProductRuntimeConfig | undefined,
  options: { readonly safeMode?: boolean } = {},
): RuntimeContext {
  const profile = pickField(
    selection.profile === undefined ? undefined : parseProfileName(selection.profile),
    envText('TARS_NG_PROFILE') === undefined ? undefined : parseProfileName(envText('TARS_NG_PROFILE')!),
    fileRuntime?.profile === undefined ? undefined : parseProfileName(fileRuntime.profile),
    DEFAULT_PROFILE_NAME,
  )
  const workspace = pickField(
    selection.workspace,
    envText('TARS_NG_WORKSPACE'),
    fileRuntime?.workspace,
    defaultWorkspaceDir(layout.root),
  )
  const sessionRoot = pickField(
    selection.sessionRoot,
    envText('TARS_NG_SESSION_ROOT'),
    fileRuntime?.sessionRoot,
    defaultSessionRootDir(layout.root),
  )
  const sessionId = pickField(
    selection.sessionId === undefined ? undefined : parseSessionId(selection.sessionId),
    envText('TARS_NG_SESSION_ID') === undefined ? undefined : parseSessionId(envText('TARS_NG_SESSION_ID')!),
    fileRuntime?.sessionId === undefined ? undefined : parseSessionId(fileRuntime.sessionId),
    DEFAULT_SESSION_ID,
  )

  const resolvedWorkspace = inspectDir(workspace.value, 'workspace', workspace.source !== 'default')
  const resolvedSessionRoot = inspectDir(sessionRoot.value, 'session-root', false)
  if (resolvedWorkspace === layout.root || resolvedSessionRoot === layout.root) {
    throw new RuntimeContextError('workspace and session-root must stay inside distinct product paths')
  }
  if (resolvedWorkspace === resolvedSessionRoot) {
    throw new RuntimeContextError('workspace and session-root must be different directories')
  }

  const existing = readRuntimeBinding(layout)
  const loaded = tryLoadGovernedAssistantComposition()
  let profileIdentity: string
  let profileCompositionError: string | undefined
  let safeMode = options.safeMode === true
  if (loaded.ok) {
    profileIdentity = profileIdentityOf(loaded.composition)
  } else {
    profileCompositionError = loaded.error
    safeMode = true
    if (existing) {
      profileIdentity = existing.profileIdentity
    } else {
      const recovery = tryLoadGovernedAssistantComposition({ recovery: true })
      if (!recovery.ok) {
        throw new RuntimeContextError(`recovery Profile is unavailable: ${recovery.error}`)
      }
      profileIdentity = profileIdentityOf(recovery.composition)
    }
  }

  const inspected = contextFromResolved(
    layout,
    profile,
    workspace,
    sessionRoot,
    sessionId,
    resolvedWorkspace,
    resolvedSessionRoot,
    {
      safeMode,
      migrated: false,
      profileIdentity,
      ...(profileCompositionError === undefined ? {} : { profileCompositionError }),
    },
  )
  if (existing) {
    if (existing.home !== layout.root || existing.profile !== profile.value) {
      throw new RuntimeContextError('runtime context mismatch: this Home is bound to a different Profile/Workspace/Session Root')
    }
    const legacyNameIdentity = existing.profileIdentity === existing.profile
    if (
      !legacyNameIdentity
      && existing.profileIdentity !== inspected.profileIdentity
      && profileCompositionError === undefined
    ) {
      throw new RuntimeContextError('Profile migration required: this Home is bound to a different resolved Profile identity')
    }
    if (
      existing.workspaceIdentity !== inspected.workspaceIdentity
      || existing.sessionRootIdentity !== inspected.sessionRootIdentity
    ) {
      throw new RuntimeContextError('runtime context mismatch: this Home is bound to a different Profile/Workspace/Session Root')
    }
    const bound = {
      ...inspected,
      profileIdentity: existing.profileIdentity,
      workspace: { ...workspace, value: existing.workspace },
      sessionRoot: { ...sessionRoot, value: existing.sessionRoot },
    }
    assertSessionRootOwner(existing.sessionRoot, bound)
    return {
      ...bound,
      sessionPersistenceDir: sessionPersistenceDirOf({
        home: bound.home,
        profileIdentity: bound.profileIdentity,
        workspaceIdentity: bound.workspaceIdentity,
        sessionRoot: bound.sessionRoot,
      }),
    }
  }
  assertSessionRootOwner(resolvedSessionRoot, inspected)
  return inspected
}

function upgradeLegacyProfileBinding(
  layout: ProductHomeLayout,
  existing: RuntimeBinding,
  inspected: RuntimeContext,
  options: { readonly allowFixtures: boolean },
): RuntimeContext {
  const loaded = tryLoadGovernedAssistantComposition()
  if (!loaded.ok) {
    return inspectRuntimeContext(layout, {
      profile: inspected.profile.value,
      workspace: inspected.workspace.value,
      sessionRoot: inspected.sessionRoot.value,
      sessionId: inspected.sessionId.value,
    }, {
      schemaVersion: RUNTIME_CONTEXT_SCHEMA_VERSION,
      profile: existing.profile,
      workspace: existing.workspace,
      sessionRoot: existing.sessionRoot,
      sessionId: inspected.sessionId.value,
    }, { safeMode: true })
  }
  const nextIdentity = profileIdentityOf(loaded.composition)
  if (nextIdentity === existing.profileIdentity) {
    return inspected
  }
  const previous = {
    home: existing.home,
    profileIdentity: existing.profileIdentity,
    workspaceIdentity: existing.workspaceIdentity,
    sessionRoot: { value: existing.sessionRoot, source: inspected.sessionRoot.source },
  }
  const next = {
    home: existing.home,
    profileIdentity: nextIdentity,
    workspaceIdentity: existing.workspaceIdentity,
    sessionRoot: previous.sessionRoot,
  }
  const oldDir = sessionPersistenceDirOf(previous)
  const newDir = sessionPersistenceDirOf(next)
  if (existsSync(oldDir) && oldDir !== newDir && !existsSync(newDir)) {
    mkdirSync(path.dirname(newDir), { recursive: true, mode: 0o700 })
    renameSync(oldDir, newDir)
  }
  const owner = readSessionRootOwner(existing.sessionRoot)
  if (owner && owner.profileIdentity === existing.profileIdentity) {
    writeJsonAtomic(sessionRootOwnerFile(existing.sessionRoot), {
      ...owner,
      profileIdentity: nextIdentity,
      partitionKey: partitionKeyOf(next),
    })
  }
  const upgraded: RuntimeContext = {
    ...inspected,
    profileIdentity: nextIdentity,
    sessionPersistenceDir: newDir,
    migrated: true,
  }
  writeRuntimeBinding(layout, {
    schemaVersion: RUNTIME_CONTEXT_SCHEMA_VERSION,
    home: existing.home,
    profile: existing.profile,
    profileIdentity: nextIdentity,
    workspace: existing.workspace,
    workspaceIdentity: existing.workspaceIdentity,
    sessionRoot: existing.sessionRoot,
    sessionRootIdentity: existing.sessionRootIdentity,
  })
  writeProductRuntimeSection(layout, options.allowFixtures, {
    schemaVersion: RUNTIME_CONTEXT_SCHEMA_VERSION,
    profile: existing.profile,
    workspace: existing.workspace,
    sessionRoot: existing.sessionRoot,
    sessionId: inspected.sessionId.value,
  })
  return upgraded
}

export function commitRuntimeContext(
  layout: ProductHomeLayout,
  inspected: RuntimeContext,
  options: { readonly allowFixtures: boolean },
): RuntimeContext {
  const existing = readRuntimeBinding(layout)
  if (existing) {
    if (existing.profileIdentity === existing.profile && inspected.profileCompositionError === undefined) {
      return upgradeLegacyProfileBinding(layout, existing, inspected, options)
    }
    return inspectRuntimeContext(layout, {
      profile: inspected.profile.value,
      workspace: inspected.workspace.value,
      sessionRoot: inspected.sessionRoot.value,
      sessionId: inspected.sessionId.value,
    }, {
      schemaVersion: RUNTIME_CONTEXT_SCHEMA_VERSION,
      profile: existing.profile,
      workspace: existing.workspace,
      sessionRoot: existing.sessionRoot,
      sessionId: inspected.sessionId.value,
    }, { safeMode: inspected.safeMode })
  }

  if (inspected.profileCompositionError !== undefined) {
    return inspected
  }

  const ownedWorkspace = inspected.workspace.source === 'default'
    ? createOwnedDir(inspected.workspace.value)
    : inspectDir(inspected.workspace.value, 'workspace', true)
  const sessionRootPath = path.resolve(inspected.sessionRoot.value)
  const ownedSessionRoot = existsSync(sessionRootPath)
    ? inspectDir(sessionRootPath, 'session-root', true)
    : createOwnedDir(sessionRootPath)
  const committed = contextFromResolved(
    layout,
    inspected.profile,
    { ...inspected.workspace, value: ownedWorkspace },
    { ...inspected.sessionRoot, value: ownedSessionRoot },
    inspected.sessionId,
    ownedWorkspace,
    ownedSessionRoot,
    { safeMode: inspected.safeMode, migrated: true, profileIdentity: inspected.profileIdentity, profileCompositionError: inspected.profileCompositionError },
  )
  backupBeforeMigration(layout)
  writeProductRuntimeSection(layout, options.allowFixtures, {
    schemaVersion: RUNTIME_CONTEXT_SCHEMA_VERSION,
    profile: committed.profile.value,
    workspace: committed.workspace.value,
    sessionRoot: committed.sessionRoot.value,
    sessionId: committed.sessionId.value,
  })
  writeRuntimeBinding(layout, {
    schemaVersion: RUNTIME_CONTEXT_SCHEMA_VERSION,
    home: committed.home,
    profile: committed.profile.value,
    profileIdentity: committed.profileIdentity,
    workspace: committed.workspace.value,
    workspaceIdentity: committed.workspaceIdentity,
    sessionRoot: committed.sessionRoot.value,
    sessionRootIdentity: committed.sessionRootIdentity,
  })
  return committed
}

export function resolveRuntimeContext(
  layout: ProductHomeLayout,
  selection: RuntimeSelection,
  fileRuntime: ProductRuntimeConfig | undefined,
  options: { readonly allowFixtures: boolean; readonly safeMode?: boolean; readonly persist?: boolean } = { allowFixtures: false },
): RuntimeContext {
  const inspected = inspectRuntimeContext(layout, selection, fileRuntime, { safeMode: options.safeMode })
  if (options.persist === false) return inspected
  return commitRuntimeContext(layout, inspected, { allowFixtures: options.allowFixtures })
}

export function publicRuntimeContextView(context: RuntimeContext): {
  readonly profile: string
  readonly profileIdentity: string
  readonly workspaceLabel: string
  readonly workspaceIdentity: string
  readonly sessionId: string
  readonly sessionPersistence: 'persistent' | 'unavailable' | 'recovery-required'
  readonly safeMode: boolean
  readonly profileCompositionError?: string
  readonly sources: {
    readonly profile: ConfigSource
    readonly workspace: ConfigSource
    readonly sessionRoot: ConfigSource
    readonly sessionId: ConfigSource
  }
} {
  return {
    profile: context.profile.value,
    profileIdentity: context.profileIdentity,
    workspaceLabel: context.workspaceLabel,
    workspaceIdentity: context.workspaceIdentity,
    sessionId: context.sessionId.value,
    sessionPersistence: context.safeMode ? 'recovery-required' : 'persistent',
    safeMode: context.safeMode,
    ...(context.profileCompositionError === undefined ? {} : { profileCompositionError: context.profileCompositionError }),
    sources: {
      profile: context.profile.source,
      workspace: context.workspace.source,
      sessionRoot: context.sessionRoot.source,
      sessionId: context.sessionId.source,
    },
  }
}

export function resolveCliSelection(input: RuntimeSelection): RuntimeSelection {
  return {
    ...(input.profile === undefined ? {} : { profile: firstDefined([input.profile]) }),
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
    ...(input.sessionRoot === undefined ? {} : { sessionRoot: input.sessionRoot }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
  }
}
