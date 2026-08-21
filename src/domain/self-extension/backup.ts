import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { writeJsonAtomic } from '../persistence/atomic.js'
import { parseAuthorityFile } from './authority-store.js'
import { PersistenceIntegrityError, PersistenceSchemaError } from './errors.js'
import { SELF_EXTENSION_SCHEMA_VERSION, selfExtensionPaths } from './home.js'

export const BACKUP_KIND = 'self-extension-authority'
export const BACKUP_SCHEMA_VERSION = 1

export const BACKUP_EXCLUDES = [
  'secrets',
  'credentials',
  'DSH_HOME',
  'session-store',
  'personal-memory',
  'environment-variables',
] as const

export interface SelfExtensionBackupManifest {
  readonly kind: typeof BACKUP_KIND
  readonly schemaVersion: number
  readonly createdAt: string
  readonly authoritySchemaVersion: number
  readonly files: readonly string[]
  readonly excludes: readonly string[]
}

function listRelativeFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir)) {
      const relative = prefix === '' ? entry : `${prefix}/${entry}`
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) walk(full, relative)
      else out.push(relative)
    }
  }
  if (existsSync(root)) walk(root, '')
  return out.sort()
}

function assertNotNested(dest: string, sourceRoot: string): void {
  const resolvedDest = path.resolve(dest)
  const resolvedSource = path.resolve(sourceRoot)
  if (resolvedDest === resolvedSource || resolvedDest.startsWith(`${resolvedSource}${path.sep}`)) {
    throw new PersistenceIntegrityError('backup destination must not be inside the durable Self-Extension tree')
  }
}

export function parseBackupManifest(parsed: unknown): SelfExtensionBackupManifest {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PersistenceIntegrityError('backup manifest must be an object')
  }
  const file = parsed as { kind?: unknown; schemaVersion?: unknown }
  if (file.kind !== BACKUP_KIND) throw new PersistenceIntegrityError('not a self-extension authority backup')
  if (file.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new PersistenceSchemaError(`unsupported backup schema ${String(file.schemaVersion)}`)
  }
  return parsed as SelfExtensionBackupManifest
}

/** Copy authority + sealed artifacts. Does not copy secrets, sessions, or memory. */
export function backupSelfExtension(assistantHome: string, dest: string): SelfExtensionBackupManifest {
  const home = selfExtensionPaths(assistantHome)
  if (!existsSync(home.authorityPath)) throw new PersistenceIntegrityError('no authority.json to back up')
  parseAuthorityFile(JSON.parse(readFileSync(home.authorityPath, 'utf8')))
  assertNotNested(dest, home.root)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  cpSync(home.authorityPath, path.join(dest, 'authority.json'))
  if (existsSync(home.candidateArea)) {
    cpSync(home.candidateArea, path.join(dest, 'candidates'), { recursive: true })
  }
  const files = listRelativeFiles(dest)
  const manifest: SelfExtensionBackupManifest = {
    kind: BACKUP_KIND,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    authoritySchemaVersion: SELF_EXTENSION_SCHEMA_VERSION,
    files,
    excludes: [...BACKUP_EXCLUDES],
  }
  writeJsonAtomic(path.join(dest, 'manifest.json'), manifest)
  return parseBackupManifest(JSON.parse(readFileSync(path.join(dest, 'manifest.json'), 'utf8')))
}

/** Replace durable Self-Extension files. Next boot still runs schema/digest/remount checks. */
export function restoreSelfExtension(source: string, assistantHome: string): void {
  const manifestPath = path.join(source, 'manifest.json')
  if (!existsSync(manifestPath)) throw new PersistenceIntegrityError('backup is missing manifest.json')
  parseBackupManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
  const authorityPath = path.join(source, 'authority.json')
  if (!existsSync(authorityPath)) throw new PersistenceIntegrityError('backup is missing authority.json')
  parseAuthorityFile(JSON.parse(readFileSync(authorityPath, 'utf8')))
  const indexPath = path.join(source, 'candidates', 'index.json')
  if (existsSync(indexPath)) {
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { schemaVersion?: unknown }
    if (index.schemaVersion !== SELF_EXTENSION_SCHEMA_VERSION) {
      throw new PersistenceSchemaError(`unsupported candidate index schema ${String(index.schemaVersion)}`)
    }
  }
  const dest = selfExtensionPaths(assistantHome)
  assertNotNested(source, dest.root)
  const staging = `${dest.root}.restore-${process.pid}`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  cpSync(authorityPath, path.join(staging, 'authority.json'))
  if (existsSync(path.join(source, 'candidates'))) {
    cpSync(path.join(source, 'candidates'), path.join(staging, 'candidates'), { recursive: true })
  }
  mkdirSync(path.dirname(dest.root), { recursive: true })
  rmSync(dest.root, { recursive: true, force: true })
  renameSync(staging, dest.root)
}
