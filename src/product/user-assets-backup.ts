import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { backupSelfExtension, restoreSelfExtension } from '../domain/self-extension/backup.js'
import { writeJsonAtomic } from '../domain/persistence/atomic.js'
import type { ProductHomeLayout } from './home.js'

export const USER_ASSET_BACKUP_KIND = 'tars-ng-user-assets'
export const USER_ASSET_BACKUP_SCHEMA_VERSION = 1
export const DEFAULT_BACKUP_RETENTION_DAYS = 14

export interface UserAssetBackupManifest {
  readonly kind: typeof USER_ASSET_BACKUP_KIND
  readonly schemaVersion: number
  readonly createdAt: string
  readonly day: string
  readonly files: readonly { readonly path: string; readonly sha256: string; readonly bytes: number }[]
  readonly includes: readonly string[]
  readonly excludes: readonly string[]
}

export interface BackupDrillResult {
  readonly ok: true
  readonly verifiedAt: string
  readonly filesVerified: number
  readonly assets: readonly string[]
}

export interface DailyBackupResult {
  readonly state: 'created' | 'current'
  readonly path: string
  readonly manifest: UserAssetBackupManifest
  readonly drill: BackupDrillResult
}

function localDay(now: Date): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function walkFiles(root: string, prefix = ''): string[] {
  if (!existsSync(root)) return []
  const files: string[] = []
  for (const name of readdirSync(root).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name
    const full = path.join(root, name)
    const stat = lstatSync(full)
    if (stat.isSymbolicLink()) throw new Error(`backup refuses symbolic link: ${relative}`)
    if (stat.isDirectory()) files.push(...walkFiles(full, relative))
    else if (stat.isFile()) files.push(relative)
  }
  return files
}

function digestFile(file: string): { readonly sha256: string; readonly bytes: number } {
  const bytes = readFileSync(file)
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
}

function validateJsonAssets(root: string): void {
  for (const relative of walkFiles(root)) {
    const file = path.join(root, relative)
    if (relative.endsWith('.json')) JSON.parse(readFileSync(file, 'utf8'))
    if (relative.endsWith('.jsonl')) {
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) if (line.trim()) JSON.parse(line)
    }
  }
}

function copyIfPresent(source: string, destination: string): boolean {
  if (!existsSync(source)) return false
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
  cpSync(source, destination, { recursive: true, errorOnExist: true })
  return true
}

function copyTreeAssets(source: string, destination: string, label: string, ignoredNames: ReadonlySet<string> = new Set()): boolean {
  if (!existsSync(source)) return false
  const walk = (from: string, to: string) => {
    mkdirSync(to, { recursive: true, mode: 0o700 })
    for (const name of readdirSync(from)) {
      if (ignoredNames.has(name)) continue
      const sourceEntry = path.join(from, name)
      const destinationEntry = path.join(to, name)
      const stat = lstatSync(sourceEntry)
      if (stat.isSymbolicLink()) throw new Error(`backup refuses symbolic link in ${label}: ${name}`)
      if (stat.isDirectory()) walk(sourceEntry, destinationEntry)
      else if (stat.isFile()) copyFileSync(sourceEntry, destinationEntry)
    }
  }
  walk(source, destination)
  return true
}

const NON_SECRET_SETTINGS = new Set([
  'DSH_ASSISTANT_FEISHU_MODE',
  'DSH_ASSISTANT_FEISHU_CALENDAR_MODE',
  'DSH_ASSISTANT_FEISHU_PROFILE',
  'DSH_ASSISTANT_GOOGLE_CALENDAR_MODE',
  'DSH_ASSISTANT_KNOWLEDGE_OBSIDIAN_VAULT',
  'DSH_ASSISTANT_SANDBOX_ROOT',
])

function copySanitizedSettings(envFile: string, destination: string): boolean {
  if (!existsSync(envFile)) return false
  const settings: Record<string, string> = {}
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match || !NON_SECRET_SETTINGS.has(match[1]!)) continue
    let value = match[2] ?? ''
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    settings[match[1]!] = value
  }
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
  writeJsonAtomic(destination, { schemaVersion: 1, settings })
  return true
}

function parseManifest(value: unknown): UserAssetBackupManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid user asset backup manifest')
  const record = value as Partial<UserAssetBackupManifest>
  if (record.kind !== USER_ASSET_BACKUP_KIND || record.schemaVersion !== USER_ASSET_BACKUP_SCHEMA_VERSION || !Array.isArray(record.files)) {
    throw new Error('unsupported user asset backup manifest')
  }
  return record as UserAssetBackupManifest
}

export function inspectUserAssetBackup(directory: string): UserAssetBackupManifest {
  return parseManifest(JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8')))
}

export function createUserAssetBackup(input: {
  readonly layout: ProductHomeLayout
  readonly sessionDirectory: string
  readonly destination: string
  readonly now?: Date
}): UserAssetBackupManifest {
  const now = input.now ?? new Date()
  const sessionRoot = path.resolve(input.sessionDirectory)
  const destinationRoot = path.resolve(input.destination)
  if (sessionRoot === destinationRoot || sessionRoot.startsWith(`${destinationRoot}${path.sep}`) || destinationRoot.startsWith(`${sessionRoot}${path.sep}`)) {
    throw new Error('session directory and backup destination must be disjoint')
  }
  const staging = `${input.destination}.staging-${process.pid}`
  rmSync(staging, { recursive: true, force: true })
  try {
    mkdirSync(staging, { recursive: true, mode: 0o700 })
    const includes: string[] = []
    if (copyTreeAssets(input.sessionDirectory, path.join(staging, 'sessions'), 'sessions', new Set(['.writer.lock']))) includes.push('sessions')
    if (copyTreeAssets(path.join(input.layout.root, 'attachments'), path.join(staging, 'attachments'), 'attachments')) includes.push('attachments')
    if (copyIfPresent(input.layout.memoryFile, path.join(staging, 'data', 'memory.json'))) includes.push('memory')
    if (copyIfPresent(input.layout.productConfigFile, path.join(staging, 'config', 'product.json'))) includes.push('product-config')
    if (copySanitizedSettings(input.layout.envFile, path.join(staging, 'config', 'settings.json'))) includes.push('non-secret-settings')
    if (existsSync(path.join(input.layout.root, 'self-extension', 'authority.json'))) {
      backupSelfExtension(input.layout.root, path.join(staging, 'self-extension'))
      includes.push('capability-governance')
    }
    const files = walkFiles(staging).map((relative) => ({ path: relative, ...digestFile(path.join(staging, relative)) }))
    const manifest: UserAssetBackupManifest = {
      kind: USER_ASSET_BACKUP_KIND,
      schemaVersion: USER_ASSET_BACKUP_SCHEMA_VERSION,
      createdAt: now.toISOString(),
      day: localDay(now),
      files,
      includes,
      excludes: ['secret-values', 'lark-cli-credentials', 'logs', 'spill-cache', 'derived-session-index', 'unsealed-candidate-workspaces'],
    }
    writeJsonAtomic(path.join(staging, 'manifest.json'), manifest)
    rmSync(input.destination, { recursive: true, force: true })
    renameSync(staging, input.destination)
    return manifest
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

export function rehearseUserAssetRestore(source: string): BackupDrillResult {
  const manifest = inspectUserAssetBackup(source)
  for (const file of manifest.files) {
    const actual = digestFile(path.join(source, file.path))
    if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes) throw new Error(`backup integrity mismatch: ${file.path}`)
  }
  const drillRoot = mkdtempSync(path.join(os.tmpdir(), 'tars-ng-restore-drill-'))
  try {
    const restoredHome = path.join(drillRoot, 'home')
    mkdirSync(restoredHome, { recursive: true, mode: 0o700 })
    if (existsSync(path.join(source, 'sessions'))) {
      cpSync(path.join(source, 'sessions'), path.join(restoredHome, 'sessions'), { recursive: true })
      validateJsonAssets(path.join(restoredHome, 'sessions'))
    }
    if (existsSync(path.join(source, 'attachments'))) {
      copyTreeAssets(path.join(source, 'attachments'), path.join(restoredHome, 'attachments'), 'attachments')
    }
    if (existsSync(path.join(source, 'data', 'memory.json'))) {
      copyIfPresent(path.join(source, 'data', 'memory.json'), path.join(restoredHome, 'data', 'memory.json'))
      JSON.parse(readFileSync(path.join(restoredHome, 'data', 'memory.json'), 'utf8'))
    }
    if (existsSync(path.join(source, 'config', 'product.json'))) {
      copyIfPresent(path.join(source, 'config', 'product.json'), path.join(restoredHome, 'config', 'product.json'))
      JSON.parse(readFileSync(path.join(restoredHome, 'config', 'product.json'), 'utf8'))
    }
    if (existsSync(path.join(source, 'config', 'settings.json'))) JSON.parse(readFileSync(path.join(source, 'config', 'settings.json'), 'utf8'))
    if (existsSync(path.join(source, 'self-extension'))) restoreSelfExtension(path.join(source, 'self-extension'), restoredHome)
    return { ok: true, verifiedAt: new Date().toISOString(), filesVerified: manifest.files.length, assets: manifest.includes }
  } finally {
    rmSync(drillRoot, { recursive: true, force: true })
  }
}

export function ensureDailyUserAssetBackup(input: {
  readonly layout: ProductHomeLayout
  readonly sessionDirectory: string
  readonly now?: Date
  readonly retentionDays?: number
}): DailyBackupResult {
  const now = input.now ?? new Date()
  const destination = path.join(input.layout.backups, 'daily', localDay(now))
  let state: DailyBackupResult['state'] = 'current'
  let manifest: UserAssetBackupManifest
  if (existsSync(path.join(destination, 'manifest.json'))) manifest = inspectUserAssetBackup(destination)
  else {
    manifest = createUserAssetBackup({ ...input, destination, now })
    state = 'created'
  }
  const drillPath = path.join(destination, 'restore-drill.json')
  const drill = state === 'current' && existsSync(drillPath)
    ? JSON.parse(readFileSync(drillPath, 'utf8')) as BackupDrillResult
    : rehearseUserAssetRestore(destination)
  if (!existsSync(drillPath)) writeJsonAtomic(drillPath, drill)
  pruneDailyBackups(path.join(input.layout.backups, 'daily'), input.retentionDays ?? DEFAULT_BACKUP_RETENTION_DAYS, now)
  return { state, path: destination, manifest, drill }
}

function pruneDailyBackups(root: string, retentionDays: number, now: Date): void {
  if (!existsSync(root) || !Number.isInteger(retentionDays) || retentionDays < 1) return
  const cutoff = now.getTime() - retentionDays * 86_400_000
  for (const name of readdirSync(root)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue
    const timestamp = new Date(`${name}T00:00:00`).getTime()
    if (Number.isFinite(timestamp) && timestamp < cutoff) rmSync(path.join(root, name), { recursive: true, force: true })
  }
}
