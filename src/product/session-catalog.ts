import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { writeJsonAtomic } from '../domain/persistence/atomic.js'
import { redactText } from '../domain/workspace/redact.js'
import { DEFAULT_SESSION_ID, parseSessionId, type RuntimeContext } from './runtime-context.js'

export const SESSION_CATALOG_SCHEMA_VERSION = 1
export const SESSION_CATALOG_JOURNAL_SCHEMA_VERSION = 1
export const DEFAULT_CONVERSATION_TITLE = 'New conversation'
export const MIGRATED_MAIN_TITLE = 'Conversation'

export type SessionLifecycle = 'active' | 'archived'

export class SessionCatalogError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'SessionCatalogError'
    this.code = code
  }
}

export interface SessionCatalogBinding {
  readonly home: string
  readonly profileIdentity: string
  readonly workspaceIdentity: string
  readonly sessionRootIdentity: string
}

export interface SessionRecord {
  readonly id: string
  readonly title: string
  readonly lifecycle: SessionLifecycle
  readonly createdAt: string
  readonly lastActivityAt: string
  readonly preview?: string
  readonly persistence: 'persistent' | 'unavailable' | 'recovery-required'
}

export interface SessionCatalogFile {
  readonly schemaVersion: number
  readonly binding: SessionCatalogBinding
  readonly currentSessionId: string
  readonly revision: number
  readonly sessions: readonly SessionRecord[]
  readonly approvalOrigins: Readonly<Record<string, string>>
}

export interface PublicSessionView {
  readonly id: string
  readonly title: string
  readonly lifecycle: SessionLifecycle
  readonly createdAt: string
  readonly lastActivityAt: string
  readonly preview?: string
  readonly persistence: SessionRecord['persistence']
  readonly current: boolean
}

export interface PublicSessionCatalog {
  readonly schemaVersion: number
  readonly revision: number
  readonly currentSessionId: string
  readonly health: 'ok' | 'absent' | 'recovery-required'
  readonly activeCount: number
  readonly archivedCount: number
  readonly sessions: readonly PublicSessionView[]
}

export type CatalogTransactionOp = 'create' | 'switch' | 'archive' | 'delete'

export interface CatalogJournal {
  readonly schemaVersion: number
  readonly op: CatalogTransactionOp
  readonly fromSessionId: string
  readonly toSessionId: string
  readonly previous: SessionCatalogFile
  readonly phase: 'prepared' | 'committed'
  readonly unlink?: readonly string[]
}

export function sessionCatalogFile(sessionPersistenceDir: string): string {
  return path.join(sessionPersistenceDir, '.tars-ng-catalog.json')
}

export function sessionCatalogJournalFile(sessionPersistenceDir: string): string {
  return path.join(sessionPersistenceDir, '.tars-ng-catalog.journal.json')
}

export function catalogBindingOf(context: Pick<RuntimeContext, 'home' | 'profileIdentity' | 'workspaceIdentity' | 'sessionRootIdentity'>): SessionCatalogBinding {
  return {
    home: context.home,
    profileIdentity: context.profileIdentity,
    workspaceIdentity: context.workspaceIdentity,
    sessionRootIdentity: context.sessionRootIdentity,
  }
}

function sameBinding(left: SessionCatalogBinding, right: SessionCatalogBinding): boolean {
  return left.home === right.home
    && left.profileIdentity === right.profileIdentity
    && left.workspaceIdentity === right.workspaceIdentity
    && left.sessionRootIdentity === right.sessionRootIdentity
}

function parseTitle(value: string | undefined): string {
  const title = (value ?? DEFAULT_CONVERSATION_TITLE).trim()
  if (title === '') return DEFAULT_CONVERSATION_TITLE
  if (title.includes('/') || title.includes('\\') || title.includes('..')) {
    throw new SessionCatalogError('invalid-title', 'session title cannot contain path syntax')
  }
  return title.slice(0, 80)
}

function nowIso(): string {
  return new Date().toISOString()
}

function parseIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new SessionCatalogError('corrupt', `session catalog ${label} is not a valid timestamp`)
  }
  return value
}

function parseStoredTitle(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SessionCatalogError('corrupt', 'session catalog title is missing')
  }
  try {
    return parseTitle(value)
  } catch {
    throw new SessionCatalogError('corrupt', 'session catalog title is invalid')
  }
}

function generateSessionId(): string {
  return parseSessionId(`t${randomBytes(8).toString('hex')}`)
}

export function inspectSessionCatalog(
  sessionPersistenceDir: string,
  binding: SessionCatalogBinding,
): PublicSessionCatalog {
  const file = sessionCatalogFile(sessionPersistenceDir)
  if (!existsSync(file)) {
    return {
      schemaVersion: SESSION_CATALOG_SCHEMA_VERSION,
      revision: 0,
      currentSessionId: DEFAULT_SESSION_ID,
      health: 'absent',
      activeCount: 0,
      archivedCount: 0,
      sessions: [],
    }
  }
  const stored = readCatalogFile(file, binding)
  return publicView(stored)
}

function publicView(stored: SessionCatalogFile): PublicSessionCatalog {
  const sessions = stored.sessions.map((item) => ({
    ...item,
    current: item.id === stored.currentSessionId,
  }))
  return {
    schemaVersion: stored.schemaVersion,
    revision: stored.revision,
    currentSessionId: stored.currentSessionId,
    health: 'ok',
    activeCount: stored.sessions.filter((item) => item.lifecycle === 'active').length,
    archivedCount: stored.sessions.filter((item) => item.lifecycle === 'archived').length,
    sessions,
  }
}

function readCatalogFile(file: string, binding: SessionCatalogBinding): SessionCatalogFile {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new SessionCatalogError('corrupt', 'session catalog is corrupt')
  }
  if (raw === null || typeof raw !== 'object') {
    throw new SessionCatalogError('corrupt', 'session catalog is corrupt')
  }
  const record = raw as Partial<SessionCatalogFile>
  if (typeof record.schemaVersion === 'number' && record.schemaVersion > SESSION_CATALOG_SCHEMA_VERSION) {
    throw new SessionCatalogError('unsupported-schema', `unsupported session catalog schema ${record.schemaVersion}`)
  }
  if (record.schemaVersion !== SESSION_CATALOG_SCHEMA_VERSION
    || record.binding === undefined
    || typeof record.currentSessionId !== 'string'
    || typeof record.revision !== 'number'
    || !Number.isInteger(record.revision)
    || record.revision < 1
    || !Array.isArray(record.sessions)
  ) {
    throw new SessionCatalogError('corrupt', 'session catalog is corrupt')
  }
  if (!sameBinding(record.binding, binding)) {
    throw new SessionCatalogError('context-mismatch', 'session catalog is bound to another Home/Profile/Workspace')
  }
  const sessions: SessionRecord[] = []
  const seen = new Set<string>()
  for (const item of record.sessions) {
    if (item === null || typeof item !== 'object') {
      throw new SessionCatalogError('corrupt', 'session catalog is corrupt')
    }
    const row = item as Partial<SessionRecord>
    const id = parseSessionId(String(row.id ?? ''))
    if (seen.has(id)) throw new SessionCatalogError('corrupt', 'session catalog has duplicate ids')
    seen.add(id)
    if (row.lifecycle !== 'active' && row.lifecycle !== 'archived') {
      throw new SessionCatalogError('corrupt', 'session catalog is corrupt')
    }
    sessions.push({
      id,
      title: parseStoredTitle(row.title),
      lifecycle: row.lifecycle,
      createdAt: parseIsoTimestamp(row.createdAt, 'createdAt'),
      lastActivityAt: parseIsoTimestamp(row.lastActivityAt, 'lastActivityAt'),
      persistence: row.persistence === 'unavailable' || row.persistence === 'recovery-required' ? row.persistence : 'persistent',
      ...(typeof row.preview === 'string' && row.preview.trim() !== '' ? { preview: redactText(row.preview).slice(0, 72) } : {}),
    })
  }
  const currentSessionId = parseSessionId(record.currentSessionId)
  const current = sessions.find((item) => item.id === currentSessionId)
  if (!current || current.lifecycle !== 'active') {
    throw new SessionCatalogError('corrupt', 'session catalog current session is missing or not active')
  }
  const origins: Record<string, string> = {}
  if (record.approvalOrigins && typeof record.approvalOrigins === 'object') {
    for (const [key, value] of Object.entries(record.approvalOrigins)) {
      if (typeof key !== 'string' || key.trim() === '' || typeof value !== 'string' || value === '') {
        throw new SessionCatalogError('corrupt', 'session catalog approval origin is invalid')
      }
      origins[key] = parseSessionId(value)
    }
  }
  return {
    schemaVersion: SESSION_CATALOG_SCHEMA_VERSION,
    binding: record.binding,
    currentSessionId,
    revision: record.revision,
    sessions,
    approvalOrigins: origins,
  }
}

export class SessionCatalog {
  constructor(
    private readonly sessionPersistenceDir: string,
    private readonly binding: SessionCatalogBinding,
  ) {}

  file(): string {
    return sessionCatalogFile(this.sessionPersistenceDir)
  }

  inspect(): PublicSessionCatalog {
    return inspectSessionCatalog(this.sessionPersistenceDir, this.binding)
  }

  approvalOrigins(): Readonly<Record<string, string>> {
    if (!existsSync(this.file())) return {}
    return this.readOrThrow().approvalOrigins
  }

  load(): SessionCatalogFile {
    return this.readOrThrow()
  }

  ensureMigrated(sessionId: string): PublicSessionCatalog {
    const id = parseSessionId(sessionId)
    const file = this.file()
    if (!existsSync(file)) {
      const at = nowIso()
      this.write({
        schemaVersion: SESSION_CATALOG_SCHEMA_VERSION,
        binding: this.binding,
        currentSessionId: id,
        revision: 1,
        sessions: [{
          id,
          title: id === DEFAULT_SESSION_ID ? MIGRATED_MAIN_TITLE : DEFAULT_CONVERSATION_TITLE,
          lifecycle: 'active',
          createdAt: at,
          lastActivityAt: at,
          persistence: 'persistent',
        }],
        approvalOrigins: {},
      })
      return this.inspect()
    }
    const stored = this.readOrThrow()
    if (stored.sessions.some((item) => item.id === id)) return publicView(stored)
    const at = nowIso()
    this.write({
      ...stored,
      revision: stored.revision + 1,
      currentSessionId: stored.currentSessionId,
      sessions: [...stored.sessions, {
        id,
        title: id === DEFAULT_SESSION_ID ? MIGRATED_MAIN_TITLE : DEFAULT_CONVERSATION_TITLE,
        lifecycle: 'active',
        createdAt: at,
        lastActivityAt: at,
        persistence: 'persistent',
      }],
    })
    return this.inspect()
  }

  resolveBootSession(requested: string): string {
    const id = parseSessionId(requested)
    const stored = this.readOrThrow()
    const match = stored.sessions.find((item) => item.id === id)
    if (!match) {
      throw new SessionCatalogError('not-found', `session ${id} is not in the catalog`)
    }
    if (match.lifecycle !== 'active') {
      throw new SessionCatalogError('unavailable', `session ${id} is not an active conversation`)
    }
    if (stored.currentSessionId !== id) {
      this.write({ ...stored, currentSessionId: id, revision: stored.revision + 1 })
    }
    return id
  }

  create(title?: string, expected?: { readonly sessionId?: string; readonly revision?: number }): PublicSessionView {
    const stored = this.assertExpected(expected)
    const id = generateSessionId()
    const at = nowIso()
    const record: SessionRecord = {
      id,
      title: parseTitle(title),
      lifecycle: 'active',
      createdAt: at,
      lastActivityAt: at,
      persistence: 'persistent',
    }
    this.write({
      ...stored,
      revision: stored.revision + 1,
      sessions: [...stored.sessions, record],
    })
    return { ...record, current: false }
  }

  switchTo(id: string, expected?: { readonly sessionId?: string; readonly revision?: number }): PublicSessionCatalog {
    const stored = this.assertExpected(expected)
    const target = parseSessionId(id)
    const match = stored.sessions.find((item) => item.id === target)
    if (!match) throw new SessionCatalogError('not-found', `session ${target} is not in the catalog`)
    if (match.lifecycle !== 'active') {
      throw new SessionCatalogError('unavailable', `session ${target} is not an active conversation`)
    }
    if (stored.currentSessionId === target) return publicView(stored)
    this.write({
      ...stored,
      currentSessionId: target,
      revision: stored.revision + 1,
      sessions: stored.sessions.map((item) => item.id === target ? { ...item, lastActivityAt: nowIso() } : item),
    })
    return this.inspect()
  }

  rename(id: string, title: string, expected?: { readonly revision?: number }): PublicSessionCatalog {
    const stored = this.assertExpected(expected)
    const target = parseSessionId(id)
    if (!stored.sessions.some((item) => item.id === target)) {
      throw new SessionCatalogError('not-found', `session ${target} is not in the catalog`)
    }
    const nextTitle = parseTitle(title)
    this.write({
      ...stored,
      revision: stored.revision + 1,
      sessions: stored.sessions.map((item) => item.id === target ? { ...item, title: nextTitle } : item),
    })
    return this.inspect()
  }

  archive(id: string, expected?: { readonly revision?: number }): PublicSessionCatalog {
    const stored = this.assertExpected(expected)
    const target = parseSessionId(id)
    const match = stored.sessions.find((item) => item.id === target)
    if (!match) throw new SessionCatalogError('not-found', `session ${target} is not in the catalog`)
    const active = stored.sessions.filter((item) => item.lifecycle === 'active')
    if (match.lifecycle === 'active' && active.length === 1) {
      throw new SessionCatalogError('last-active', 'the last active conversation cannot be archived')
    }
    const nextCurrent = stored.currentSessionId === target
      ? active.find((item) => item.id !== target)?.id
      : stored.currentSessionId
    if (nextCurrent === undefined) {
      throw new SessionCatalogError('last-active', 'the last active conversation cannot be archived')
    }
    this.write({
      ...stored,
      currentSessionId: nextCurrent,
      revision: stored.revision + 1,
      sessions: stored.sessions.map((item) => item.id === target ? { ...item, lifecycle: 'archived' as const } : item),
    })
    return this.inspect()
  }

  restore(id: string, expected?: { readonly revision?: number }): PublicSessionCatalog {
    const stored = this.assertExpected(expected)
    const target = parseSessionId(id)
    if (!stored.sessions.some((item) => item.id === target)) {
      throw new SessionCatalogError('not-found', `session ${target} is not in the catalog`)
    }
    this.write({
      ...stored,
      revision: stored.revision + 1,
      sessions: stored.sessions.map((item) => item.id === target ? { ...item, lifecycle: 'active' as const, lastActivityAt: nowIso() } : item),
    })
    return this.inspect()
  }

  delete(id: string, expected?: { readonly revision?: number; readonly confirm?: boolean }): PublicSessionCatalog {
    if (expected?.confirm !== true) {
      throw new SessionCatalogError('confirmation-required', 'delete requires explicit confirmation')
    }
    const stored = this.assertExpected(expected)
    const target = parseSessionId(id)
    const match = stored.sessions.find((item) => item.id === target)
    if (!match) return publicView(stored)
    const remainingActive = stored.sessions.filter((item) => item.lifecycle === 'active' && item.id !== target)
    if (match.lifecycle === 'active' && remainingActive.length === 0) {
      throw new SessionCatalogError('last-active', 'the last active conversation cannot be deleted')
    }
    const nextCurrent = stored.currentSessionId === target
      ? remainingActive[0]?.id
      : stored.currentSessionId
    if (nextCurrent === undefined) {
      throw new SessionCatalogError('last-active', 'the last active conversation cannot be deleted')
    }
    this.write({
      ...stored,
      currentSessionId: nextCurrent,
      revision: stored.revision + 1,
      sessions: stored.sessions.filter((item) => item.id !== target),
    })
    return this.inspect()
  }

  touch(sessionId: string, preview?: string): void {
    const stored = this.readOrThrow()
    const id = parseSessionId(sessionId)
    if (!stored.sessions.some((item) => item.id === id)) return
    const safePreview = preview === undefined || preview.trim() === '' ? undefined : redactText(preview).slice(0, 72)
    this.write({
      ...stored,
      revision: stored.revision + 1,
      sessions: stored.sessions.map((item) => item.id === id
        ? { ...item, lastActivityAt: nowIso(), ...(safePreview ? { preview: safePreview } : {}) }
        : item),
    })
  }

  noteApprovalOrigin(confirmationId: string, sessionId: string): void {
    const stored = this.readOrThrow()
    if (stored.approvalOrigins[confirmationId] !== undefined) return
    this.write({
      ...stored,
      approvalOrigins: { ...stored.approvalOrigins, [confirmationId]: parseSessionId(sessionId) },
    })
  }

  approvalOrigin(confirmationId: string): string | undefined {
    if (!existsSync(this.file())) return undefined
    return this.readOrThrow().approvalOrigins[confirmationId]
  }

  discardDeletedPersistence(id: string): void {
    const target = parseSessionId(id)
    for (const name of [`${target}.jsonl`, `${target}.json`]) {
      const file = path.join(this.sessionPersistenceDir, name)
      if (existsSync(file)) unlinkSync(file)
    }
  }

  journalFile(): string {
    return sessionCatalogJournalFile(this.sessionPersistenceDir)
  }

  readJournal(): CatalogJournal | undefined {
    const file = this.journalFile()
    if (!existsSync(file)) return undefined
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<CatalogJournal>
      if (raw.schemaVersion !== SESSION_CATALOG_JOURNAL_SCHEMA_VERSION) return undefined
      if (raw.op !== 'create' && raw.op !== 'switch' && raw.op !== 'archive' && raw.op !== 'delete') return undefined
      if (typeof raw.fromSessionId !== 'string' || typeof raw.toSessionId !== 'string') return undefined
      if (raw.phase !== 'prepared' && raw.phase !== 'committed') return undefined
      if (raw.previous === null || typeof raw.previous !== 'object') return undefined
      return {
        schemaVersion: SESSION_CATALOG_JOURNAL_SCHEMA_VERSION,
        op: raw.op,
        fromSessionId: raw.fromSessionId,
        toSessionId: raw.toSessionId,
        previous: raw.previous,
        phase: raw.phase,
        ...(Array.isArray(raw.unlink) ? { unlink: raw.unlink.filter((item): item is string => typeof item === 'string') } : {}),
      }
    } catch {
      throw new SessionCatalogError('corrupt', 'session catalog journal is corrupt')
    }
  }

  writeJournal(journal: CatalogJournal): void {
    writeJsonAtomic(this.journalFile(), journal)
  }

  clearJournal(): void {
    const file = this.journalFile()
    if (existsSync(file)) unlinkSync(file)
  }

  restoreSnapshot(previous: SessionCatalogFile): void {
    this.write(previous)
  }

  private assertExpected(expected?: { readonly sessionId?: string; readonly revision?: number }): SessionCatalogFile {
    const stored = this.readOrThrow()
    if (expected?.revision !== undefined && expected.revision !== stored.revision) {
      throw new SessionCatalogError('stale-revision', 'session catalog revision is stale')
    }
    if (expected?.sessionId !== undefined && expected.sessionId !== stored.currentSessionId) {
      throw new SessionCatalogError('stale-session', 'request targeted a different current session')
    }
    return stored
  }

  private readOrThrow(): SessionCatalogFile {
    const file = this.file()
    if (!existsSync(file)) {
      throw new SessionCatalogError('absent', 'session catalog is absent')
    }
    return readCatalogFile(file, this.binding)
  }

  private write(next: SessionCatalogFile): void {
    writeJsonAtomic(this.file(), next)
  }
}
