import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
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

function secureDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dir, 0o700)
  } catch {
    // chmod may fail on some filesystems
  }
  let resolved: string
  try {
    resolved = realpathSync(dir)
  } catch {
    throw new RuntimeContextError('workspace or session-root could not be resolved')
  }
  const stats = statSync(resolved)
  if (!stats.isDirectory()) throw new RuntimeContextError('workspace or session-root must be a directory')
  return resolved
}

function resolveExistingDir(value: string, kind: 'workspace' | 'session-root'): string {
  const absolute = path.resolve(value)
  if (absolute.includes(`${path.sep}..${path.sep}`) || path.basename(value) === '..') {
    throw new RuntimeContextError(`${kind} path is invalid`)
  }
  if (kind === 'workspace' && !existsSync(absolute)) {
    throw new RuntimeContextError('workspace must be an existing directory')
  }
  return secureDir(absolute)
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
  writeFileSync(runtimeContextBindingFile(layout), `${JSON.stringify(binding, null, 2)}\n`, { mode: 0o600 })
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
  writeFileSync(layout.productConfigFile, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
}

export function resolveRuntimeContext(
  layout: ProductHomeLayout,
  selection: RuntimeSelection,
  fileRuntime: ProductRuntimeConfig | undefined,
  options: { readonly allowFixtures: boolean; readonly safeMode?: boolean } = { allowFixtures: false },
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

  const resolvedWorkspace = workspace.source === 'default'
    ? secureDir(path.resolve(workspace.value))
    : resolveExistingDir(workspace.value, 'workspace')
  const resolvedSessionRoot = secureDir(path.resolve(sessionRoot.value))
  if (resolvedWorkspace === layout.root || resolvedSessionRoot === layout.root) {
    throw new RuntimeContextError('workspace and session-root must stay inside distinct product paths')
  }
  if (resolvedWorkspace === resolvedSessionRoot) {
    throw new RuntimeContextError('workspace and session-root must be different directories')
  }

  const profileIdentity = profile.value
  const workspaceIdentity = stableIdentity(resolvedWorkspace)
  const sessionRootIdentity = stableIdentity(resolvedSessionRoot)
  const existing = readRuntimeBinding(layout)
  if (existing) {
    if (
      existing.home !== layout.root
      || existing.profile !== profile.value
      || existing.profileIdentity !== profileIdentity
      || existing.workspaceIdentity !== workspaceIdentity
      || existing.sessionRootIdentity !== sessionRootIdentity
    ) {
      throw new RuntimeContextError('runtime context mismatch: this Home is bound to a different Profile/Workspace/Session Root')
    }
    return {
      schemaVersion: RUNTIME_CONTEXT_SCHEMA_VERSION,
      home: layout.root,
      profile,
      profileIdentity,
      workspace: { ...workspace, value: existing.workspace },
      workspaceIdentity,
      workspaceLabel: workspaceLabelOf(existing.workspace),
      sessionRoot: { ...sessionRoot, value: existing.sessionRoot },
      sessionRootIdentity,
      sessionId,
      safeMode: options.safeMode === true,
      migrated: false,
    }
  }

  backupBeforeMigration(layout)
  const binding: RuntimeBinding = {
    schemaVersion: RUNTIME_CONTEXT_SCHEMA_VERSION,
    home: layout.root,
    profile: profile.value,
    profileIdentity,
    workspace: resolvedWorkspace,
    workspaceIdentity,
    sessionRoot: resolvedSessionRoot,
    sessionRootIdentity,
  }
  writeRuntimeBinding(layout, binding)
  writeProductRuntimeSection(layout, options.allowFixtures, {
    schemaVersion: RUNTIME_CONTEXT_SCHEMA_VERSION,
    profile: profile.value,
    workspace: resolvedWorkspace,
    sessionRoot: resolvedSessionRoot,
    sessionId: sessionId.value,
  })
  return {
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
    safeMode: options.safeMode === true,
    migrated: true,
  }
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
