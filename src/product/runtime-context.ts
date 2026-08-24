import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { PRODUCT_CONFIG_SCHEMA_VERSION } from './constants.js'
import type { ProductHomeLayout } from './home.js'

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

export interface SessionPartitionHold {
  readonly root: string
  release(): void
}

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

export function stampSessionRootOwner(context: RuntimeContext): void {
  const sessionRoot = context.sessionRoot.value
  assertSessionRootOwner(sessionRoot, context)
  const existing = readSessionRootOwner(sessionRoot)
  if (existing) return
  const stamp: SessionRootOwner = {
    schemaVersion: SESSION_OWNER_SCHEMA_VERSION,
    home: context.home,
    profileIdentity: context.profileIdentity,
    workspaceIdentity: context.workspaceIdentity,
    partitionKey: partitionKeyOf(context),
  }
  const file = sessionRootOwnerFile(sessionRoot)
  mkdirSync(sessionRoot, { recursive: true, mode: 0o700 })
  try {
    const fd = openSync(file, 'wx', 0o600)
    try {
      writeFileSync(fd, `${JSON.stringify(stamp, null, 2)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  assertSessionRootOwner(sessionRoot, context)
}

export function claimSessionPartition(context: RuntimeContext): SessionPartitionHold {
  stampSessionRootOwner(context)
  const root = sessionPersistenceDirOf(context)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  try {
    chmodSync(root, 0o700)
  } catch {
    // chmod may fail on some filesystems
  }
  const lockDir = path.join(root, '.writer.lock')
  try {
    mkdirSync(lockDir, { recursive: false, mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    throw new RuntimeContextError('session partition is already held by another writer')
  }
  writeFileSync(path.join(lockDir, 'holder.json'), `${JSON.stringify({
    home: context.home,
    pid: process.pid,
    partitionKey: partitionKeyOf(context),
  }, null, 2)}\n`, { mode: 0o600 })
  return {
    root,
    release() {
      rmSync(lockDir, { recursive: true, force: true })
    },
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
  options: { readonly safeMode?: boolean; readonly migrated: boolean },
): RuntimeContext {
  const profileIdentity = profile.value
  const workspaceIdentity = stableIdentity(resolvedWorkspace)
  const sessionRootIdentity = stableIdentity(resolvedSessionRoot)
  const assembled = {
    schemaVersion: RUNTIME_CONTEXT_SCHEMA_VERSION,
    home: layout.root,
    profile,
    profileIdentity,
    workspace: { ...workspace, value: resolvedWorkspace },
    workspaceIdentity,
    workspaceLabel: workspaceLabelOf(resolvedWorkspace),
    sessionRoot: { ...sessionRoot, value: resolvedSessionRoot },
    sessionRootIdentity,
    sessionId,
    sessionPersistenceDir: '',
    safeMode: options.safeMode === true,
    migrated: options.migrated,
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
  const inspected = contextFromResolved(
    layout,
    profile,
    workspace,
    sessionRoot,
    sessionId,
    resolvedWorkspace,
    resolvedSessionRoot,
    { safeMode: options.safeMode, migrated: false },
  )
  if (existing) {
    if (
      existing.home !== layout.root
      || existing.profile !== profile.value
      || existing.profileIdentity !== inspected.profileIdentity
      || existing.workspaceIdentity !== inspected.workspaceIdentity
      || existing.sessionRootIdentity !== inspected.sessionRootIdentity
    ) {
      throw new RuntimeContextError('runtime context mismatch: this Home is bound to a different Profile/Workspace/Session Root')
    }
    assertSessionRootOwner(existing.sessionRoot, inspected)
    return {
      ...inspected,
      workspace: { ...workspace, value: existing.workspace },
      sessionRoot: { ...sessionRoot, value: existing.sessionRoot },
      sessionPersistenceDir: sessionPersistenceDirOf({
        home: inspected.home,
        profileIdentity: inspected.profileIdentity,
        workspaceIdentity: inspected.workspaceIdentity,
        sessionRoot: { ...sessionRoot, value: existing.sessionRoot },
      }),
    }
  }
  assertSessionRootOwner(resolvedSessionRoot, inspected)
  return inspected
}

export function commitRuntimeContext(
  layout: ProductHomeLayout,
  inspected: RuntimeContext,
  options: { readonly allowFixtures: boolean },
): RuntimeContext {
  const existing = readRuntimeBinding(layout)
  if (existing) {
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
    { safeMode: inspected.safeMode, migrated: true },
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
  readonly workspaceLabel: string
  readonly workspaceIdentity: string
  readonly sessionId: string
  readonly sessionPersistence: 'persistent' | 'unavailable' | 'recovery-required'
  readonly safeMode: boolean
  readonly sources: {
    readonly profile: ConfigSource
    readonly workspace: ConfigSource
    readonly sessionRoot: ConfigSource
    readonly sessionId: ConfigSource
  }
} {
  return {
    profile: context.profile.value,
    workspaceLabel: context.workspaceLabel,
    workspaceIdentity: context.workspaceIdentity,
    sessionId: context.sessionId.value,
    sessionPersistence: context.safeMode ? 'recovery-required' : 'persistent',
    safeMode: context.safeMode,
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
