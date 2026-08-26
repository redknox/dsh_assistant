import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { contractDigestExtras, digestFiles } from '../candidate/digest.js'
import { listSourceFiles } from '../candidate/files.js'
import { writeJsonAtomic } from '../persistence/atomic.js'
import { parseAuthorityFile, type AuthorityFile } from './authority-store.js'
import { parseCandidateIndexFile, resolveCandidateArtifactDir, type CandidateIndexFile, type CandidateIndexRow } from './candidate-index.js'
import { isolatedRuntimeOwner } from '../generated-runtime/trust.js'
import { digestSkillFiles, readAllowlistedSkillFiles, skillId } from '../skill/bundle.js'
import { encodeSkillId, readSkillIndex, skillStoreLayout } from '../skill/store.js'
import { SKILL_SCHEMA_VERSION, type SkillIndex, type SkillRecord } from '../skill/types.js'
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
    copyDurableSkillProfile(skillStoreLayout(assistantHome, profile), path.join(dest, 'skills', profile))
  }
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

function copyDurableSkillProfile(layout: ReturnType<typeof skillStoreLayout>, dest: string): void {
  const index = readSkillIndex(layout)
  const sealed = durableSkillRecords(index)
  const tombs = index.records
    .filter((item) => item.lifecycle === 'uninstalled' && !item.sealed)
    .map(skillAuditTombstone)
  const records = [...sealed, ...tombs]
  const durableIds = new Set(records.map((item) => item.id))
  const active: Record<string, string> = {}
  for (const [name, version] of Object.entries(index.active)) {
    const id = skillId(name, version)
    if (!durableIds.has(id)) continue
    active[name] = version
  }
  const lastActive = index.lastActive !== undefined && durableIds.has(skillId(index.lastActive.name, index.lastActive.version))
    ? index.lastActive
    : undefined
  const slim: SkillIndex = {
    schemaVersion: SKILL_SCHEMA_VERSION,
    profile: layout.profile,
    records,
    active,
    generation: index.generation,
    ...(lastActive ? { lastActive } : {}),
    approvals: (index.approvals ?? []).filter((item) => durableIds.has(item.skillId)),
    reviews: (index.reviews ?? []).filter((item) => durableIds.has(item.candidateId)),
  }
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(path.join(dest, 'candidates'), { recursive: true })
  mkdirSync(path.join(dest, 'active'), { recursive: true })
  writeJsonAtomic(path.join(dest, 'index.json'), slim)
  for (const record of sealed) {
    const from = path.join(layout.candidates, encodeSkillId(record.id))
    if (!existsSync(from)) throw new PersistenceIntegrityError(`missing-skill-candidate:${record.id}`)
    if (digestSkillFiles(readAllowlistedSkillFiles(from)) !== record.digest) {
      throw new PersistenceIntegrityError(`skill-digest-mismatch:${record.id}`)
    }
    cpSync(from, path.join(dest, 'candidates', encodeSkillId(record.id)), { recursive: true })
  }
  for (const [name, version] of Object.entries(active)) {
    const record = records.find((item) => item.id === skillId(name, version))
    const from = path.join(layout.active, name)
    if (record === undefined || !existsSync(from)) throw new PersistenceIntegrityError(`missing-skill-artifact:${name}`)
    if (digestSkillFiles(readAllowlistedSkillFiles(from)) !== record.digest) {
      throw new PersistenceIntegrityError(`skill-digest-mismatch:${name}`)
    }
    cpSync(from, path.join(dest, 'active', name), { recursive: true })
  }
  verifyCopiedSkillProfile(path.dirname(dest), layout.profile)
}

function skillAuditTombstone(record: SkillRecord): SkillRecord {
  return {
    ...record,
    description: `uninstalled ${record.name}@${record.version}`,
    resources: [],
  }
}

function durableSkillRecords(index: SkillIndex): SkillRecord[] {
  return index.records.filter((item) => item.sealed && (
    item.lifecycle === 'sealed'
    || item.lifecycle === 'review-complete'
    || item.lifecycle === 'approval-requested'
    || item.lifecycle === 'approved'
    || item.lifecycle === 'active'
    || item.lifecycle === 'disabled'
    || item.lifecycle === 'uninstalled'
  ))
}

function verifySkillProfile(homeRoot: string, profile: string): void {
  verifyCopiedSkillProfile(path.join(selfExtensionPaths(homeRoot).root, 'skills'), profile)
}

function verifyCopiedSkillProfile(skillsRoot: string, profile: string): void {
  const layout = {
    root: path.join(skillsRoot, profile),
    profile,
    indexPath: path.join(skillsRoot, profile, 'index.json'),
    candidates: path.join(skillsRoot, profile, 'candidates'),
    staging: path.join(skillsRoot, profile, 'staging'),
    active: path.join(skillsRoot, profile, 'active'),
    history: path.join(skillsRoot, profile, 'history'),
  }
  if (existsSync(layout.staging) && readdirSync(layout.staging).length > 0) {
    throw new PersistenceIntegrityError('skill-backup-contains-staging')
  }
  const index = readSkillIndex(layout)
  const durable = durableSkillRecords(index)
  const leftovers = index.records.filter((item) => !durable.some((row) => row.id === item.id))
  if (leftovers.some((item) => item.lifecycle !== 'uninstalled' || item.sealed)) {
    throw new PersistenceIntegrityError('skill-backup-contains-unsealed')
  }
  if (existsSync(layout.candidates)) {
    for (const entry of readdirSync(layout.candidates)) {
      if (!durable.some((item) => encodeSkillId(item.id) === entry)) {
        throw new PersistenceIntegrityError(`unregistered-skill-candidate:${entry}`)
      }
    }
  }
  for (const record of durable) {
    const from = path.join(layout.candidates, encodeSkillId(record.id))
    if (!existsSync(from) || digestSkillFiles(readAllowlistedSkillFiles(from)) !== record.digest) {
      throw new PersistenceIntegrityError(`skill-digest-mismatch:${record.id}`)
    }
  }
  for (const [name, version] of Object.entries(index.active)) {
    const record = index.records.find((item) => item.id === skillId(name, version))
    const dest = path.join(layout.active, name)
    if (record === undefined || !existsSync(dest)) {
      throw new PersistenceIntegrityError(`missing-skill-artifact:${name}`)
    }
    if (digestSkillFiles(readAllowlistedSkillFiles(dest)) !== record.digest) {
      throw new PersistenceIntegrityError(`skill-digest-mismatch:${name}`)
    }
  }
}
