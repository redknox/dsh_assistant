import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { contractDigestExtras, digestFiles } from '../candidate/digest.js'
import { listSourceFiles } from '../candidate/files.js'
import { writeJsonAtomic } from '../persistence/atomic.js'
import { parseAuthorityFile, type AuthorityFile } from './authority-store.js'
import { parseCandidateIndexFile, resolveCandidateArtifactDir, type CandidateIndexFile, type CandidateIndexRow } from './candidate-index.js'
import { isolatedRuntimeOwner } from '../generated-runtime/trust.js'
import { digestSkillFiles, readAllowlistedSkillFiles, skillId } from '../skill/bundle.js'
import { readSkillIndex } from '../skill/store.js'
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
  'unsealed-candidate-workspaces',
  'developing-candidate-workspaces',
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

/** Reject same path, ancestor, or descendant in either direction. */
export function assertDisjointPaths(left: string, right: string, message: string): void {
  const a = path.resolve(left)
  const b = path.resolve(right)
  if (a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`)) {
    throw new PersistenceIntegrityError(message)
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

function loadIndex(indexPath: string): CandidateIndexFile {
  if (!existsSync(indexPath)) return { schemaVersion: SELF_EXTENSION_SCHEMA_VERSION, candidates: [] }
  return parseCandidateIndexFile(JSON.parse(readFileSync(indexPath, 'utf8')))
}

function ownerKey(owner: string, version: string): string {
  return `${owner}@${version}`
}

function snapshotOwnerKeys(authority: AuthorityFile, rows: readonly CandidateIndexRow[]): Set<string> {
  const index = new Map(rows.map((row) => [ownerKey(row.record.owner, row.record.version), row.record]))
  const keys = new Set<string>()
  for (const snapshot of [authority.recovery.current, authority.recovery.lastKnownGood, authority.recovery.rollbackTarget]) {
    for (const item of snapshot?.owners ?? []) {
      if (item.status !== 'active') continue
      const record = index.get(ownerKey(item.owner, item.version))
      if (isolatedRuntimeOwner(record ?? { owner: item.owner })) keys.add(ownerKey(item.owner, item.version))
    }
  }
  return keys
}

/** Sealed artifacts that approvals, LKG/current, or index retention still depend on. */
export function requiredBackupRows(authority: AuthorityFile, rows: readonly CandidateIndexRow[]): CandidateIndexRow[] {
  const approved = new Set(authority.governance.approvals.map((item) => item.candidateId))
  const owners = snapshotOwnerKeys(authority, rows)
  return rows.filter((row) => {
    if (!row.record.sealed) return false
    const retention = row.retention === 'active' || row.retention === 'sealed' || row.retention === 'rollback-retained'
    return retention || approved.has(row.record.id) || owners.has(ownerKey(row.record.owner, row.record.version))
  })
}

function verifyCandidateDigest(area: string, row: CandidateIndexRow): void {
  const artifactRoot = resolveCandidateArtifactDir(area, row.record.id)
  if (!existsSync(artifactRoot)) {
    throw new PersistenceIntegrityError(`missing-sealed-artifact:${row.record.id}`)
  }
  if (row.record.digest === undefined) {
    throw new PersistenceIntegrityError(`missing-candidate-digest:${row.record.id}`)
  }
  const digest = digestFiles(
    artifactRoot,
    listSourceFiles(artifactRoot),
    contractDigestExtras(row.record.manifest.runtimeContractVersion),
  )
  if (digest !== row.record.digest) {
    throw new PersistenceIntegrityError(`digest-mismatch:${row.record.id}`)
  }
}

function writeFilteredIndex(destDir: string, rows: readonly CandidateIndexRow[]): void {
  mkdirSync(destDir, { recursive: true })
  writeJsonAtomic(path.join(destDir, 'index.json'), {
    schemaVersion: SELF_EXTENSION_SCHEMA_VERSION,
    candidates: rows.map((row) => ({
      record: { ...row.record, workspaceRoot: row.record.id },
      retention: row.retention,
    })),
  })
}

function copyRequiredArtifacts(sourceArea: string, destArea: string, rows: readonly CandidateIndexRow[]): void {
  writeFilteredIndex(destArea, rows)
  for (const row of rows) {
    const from = resolveCandidateArtifactDir(sourceArea, row.record.id)
    const to = resolveCandidateArtifactDir(destArea, row.record.id)
    verifyCandidateDigest(sourceArea, row)
    cpSync(from, to, { recursive: true })
  }
}

/** Copy authority + required sealed artifacts. Does not copy secrets, sessions, memory, or unsealed workspaces. */
export function backupSelfExtension(assistantHome: string, dest: string): SelfExtensionBackupManifest {
  const home = selfExtensionPaths(assistantHome)
  if (!existsSync(home.authorityPath)) throw new PersistenceIntegrityError('no authority.json to back up')
  const authority = parseAuthorityFile(JSON.parse(readFileSync(home.authorityPath, 'utf8')))
  const index = loadIndex(home.candidateIndexPath)
  const required = requiredBackupRows(authority, index.candidates)
  assertDisjointPaths(dest, home.root, 'backup destination must be disjoint from the durable Self-Extension tree')
  for (const row of required) verifyCandidateDigest(home.candidateArea, row)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  cpSync(home.authorityPath, path.join(dest, 'authority.json'))
  copyRequiredArtifacts(home.candidateArea, path.join(dest, 'candidates'), required)
  copySkillAuthority(assistantHome, dest)
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

/** Replace durable Self-Extension files only after schema and artifact-digest checks. */
export function restoreSelfExtension(source: string, assistantHome: string): void {
  const manifestPath = path.join(source, 'manifest.json')
  if (!existsSync(manifestPath)) throw new PersistenceIntegrityError('backup is missing manifest.json')
  parseBackupManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
  const authorityPath = path.join(source, 'authority.json')
  if (!existsSync(authorityPath)) throw new PersistenceIntegrityError('backup is missing authority.json')
  const authority = parseAuthorityFile(JSON.parse(readFileSync(authorityPath, 'utf8')))
  const sourceArea = path.join(source, 'candidates')
  const required = requiredBackupRows(authority, loadIndex(path.join(sourceArea, 'index.json')).candidates)
  for (const row of required) verifyCandidateDigest(sourceArea, row)
  const dest = selfExtensionPaths(assistantHome)
  assertDisjointPaths(source, dest.root, 'restore source must be disjoint from the durable Self-Extension tree')
  const staging = `${dest.root}.restore-${process.pid}`
  rmSync(staging, { recursive: true, force: true })
  try {
    mkdirSync(staging, { recursive: true })
    cpSync(authorityPath, path.join(staging, 'authority.json'))
    copyRequiredArtifacts(sourceArea, path.join(staging, 'candidates'), required)
    copySkillAuthorityFromBackup(source, staging)
    mkdirSync(path.dirname(dest.root), { recursive: true })
    rmSync(dest.root, { recursive: true, force: true })
    renameSync(staging, dest.root)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function copySkillAuthority(assistantHome: string, dest: string): void {
  const root = path.join(selfExtensionPaths(assistantHome).root, 'skills')
  if (!existsSync(root)) return
  for (const profile of readdirSync(root)) {
    if (!statSync(path.join(root, profile)).isDirectory()) continue
    verifySkillProfile(assistantHome, profile)
  }
  cpSync(root, path.join(dest, 'skills'), { recursive: true })
}

function copySkillAuthorityFromBackup(source: string, staging: string): void {
  const root = path.join(source, 'skills')
  if (!existsSync(root)) return
  for (const profile of readdirSync(root)) {
    if (!statSync(path.join(root, profile)).isDirectory()) continue
    verifyCopiedSkillProfile(root, profile)
  }
  cpSync(root, path.join(staging, 'skills'), { recursive: true })
}

function verifySkillProfile(homeRoot: string, profile: string): void {
  verifyCopiedSkillProfile(path.join(selfExtensionPaths(homeRoot).root, 'skills'), profile)
}

function verifyCopiedSkillProfile(skillsRoot: string, profile: string): void {
  const index = readSkillIndex({
    root: path.join(skillsRoot, profile),
    profile,
    indexPath: path.join(skillsRoot, profile, 'index.json'),
    candidates: path.join(skillsRoot, profile, 'candidates'),
    staging: path.join(skillsRoot, profile, 'staging'),
    active: path.join(skillsRoot, profile, 'active'),
    history: path.join(skillsRoot, profile, 'history'),
  })
  for (const [name, version] of Object.entries(index.active)) {
    const record = index.records.find((item) => item.id === skillId(name, version))
    const dest = path.join(skillsRoot, profile, 'active', name)
    if (record === undefined || !existsSync(dest)) {
      throw new PersistenceIntegrityError(`missing-skill-artifact:${name}`)
    }
    if (digestSkillFiles(readAllowlistedSkillFiles(dest)) !== record.digest) {
      throw new PersistenceIntegrityError(`skill-digest-mismatch:${name}`)
    }
  }
}
