import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fsyncPath, writeSourceFileSynced } from '../candidate/files.js'
import { writeJsonAtomic } from '../persistence/atomic.js'
import { SkillContractError } from './errors.js'
import { SKILL_SCHEMA_VERSION, type SkillIndex, type SkillRecord } from './types.js'

export interface SkillStoreLayout {
  readonly root: string
  readonly profile: string
  readonly indexPath: string
  readonly candidates: string
  readonly staging: string
  readonly active: string
  readonly history: string
}

export function skillStoreLayout(homeRoot: string, profile: string): SkillStoreLayout {
  const root = path.join(path.resolve(homeRoot), 'self-extension', 'skills', profile)
  return {
    root,
    profile,
    indexPath: path.join(root, 'index.json'),
    candidates: path.join(root, 'candidates'),
    staging: path.join(root, 'staging'),
    active: path.join(root, 'active'),
    history: path.join(root, 'history'),
  }
}

export function ensureSkillStore(layout: SkillStoreLayout): SkillIndex {
  mkdirSync(layout.candidates, { recursive: true })
  mkdirSync(layout.staging, { recursive: true })
  mkdirSync(layout.active, { recursive: true })
  mkdirSync(layout.history, { recursive: true })
  if (!existsSync(layout.indexPath)) {
    const empty: SkillIndex = { schemaVersion: SKILL_SCHEMA_VERSION, profile: layout.profile, records: [], active: {} }
    writeJsonAtomic(layout.indexPath, empty)
    return empty
  }
  return readSkillIndex(layout)
}

export function readSkillIndex(layout: SkillStoreLayout): SkillIndex {
  const raw = JSON.parse(readFileSync(layout.indexPath, 'utf8')) as SkillIndex
  if (raw.schemaVersion !== SKILL_SCHEMA_VERSION) {
    throw new SkillContractError('skill-schema', 'future or corrupt skill index schema')
  }
  if (raw.profile !== layout.profile) {
    throw new SkillContractError('skill-profile', 'skill index profile does not match the selected Profile')
  }
  return raw
}

export function writeSkillIndex(layout: SkillStoreLayout, index: SkillIndex): void {
  if (index.profile !== layout.profile) {
    throw new SkillContractError('skill-profile', 'refusing to write another Profile skill index')
  }
  writeJsonAtomic(layout.indexPath, index)
}

export function candidateDir(layout: SkillStoreLayout, id: string): string {
  return path.join(layout.candidates, encodeSkillId(id))
}

export function stagingDir(layout: SkillStoreLayout, id: string): string {
  return path.join(layout.staging, encodeSkillId(id))
}

export function activeDir(layout: SkillStoreLayout, name: string): string {
  return path.join(layout.active, name)
}

export function outgoingDir(layout: SkillStoreLayout, name: string): string {
  return path.join(layout.history, `outgoing-${name}`)
}

export function incomingDir(layout: SkillStoreLayout, name: string): string {
  return stagingDir(layout, `incoming-${name}`)
}

export function encodeSkillId(id: string): string {
  return id.replace('@', '--')
}

export function publishSkillFiles(dest: string, files: Readonly<Record<string, string>>): void {
  mkdirSync(dest, { recursive: true })
  for (const [relative, content] of Object.entries(files)) {
    writeSourceFileSynced(dest, relative, content)
  }
  fsyncPath(dest)
}

export function atomicPublishDirectory(staging: string, finalDir: string): void {
  mkdirSync(path.dirname(finalDir), { recursive: true })
  if (!existsSync(finalDir)) {
    renameSync(staging, finalDir)
    return
  }
  throw new SkillContractError('skill-txn', 'refusing to replace an existing skill directory in place')
}

export function replaceActiveDirectory(input: {
  readonly incoming: string
  readonly dest: string
  readonly outgoing: string
  readonly interrupt?: 'after-outgoing' | 'after-incoming'
}): { readonly outgoingKept: boolean } {
  discardDir(input.outgoing)
  mkdirSync(path.dirname(input.dest), { recursive: true })
  let outgoingKept = false
  if (existsSync(input.dest)) {
    renameSync(input.dest, input.outgoing)
    outgoingKept = true
    if (input.interrupt === 'after-outgoing') throw new SkillContractError('skill-interrupt', 'after-outgoing')
  }
  try {
    renameSync(input.incoming, input.dest)
    if (input.interrupt === 'after-incoming') throw new SkillContractError('skill-interrupt', 'after-incoming')
    return { outgoingKept }
  } catch (error) {
    if (outgoingKept && !existsSync(input.dest) && existsSync(input.outgoing)) {
      renameSync(input.outgoing, input.dest)
    }
    throw error
  }
}

export function retireActiveDirectory(dest: string, outgoing: string, interrupt?: 'after-outgoing'): void {
  discardDir(outgoing)
  if (!existsSync(dest)) return
  renameSync(dest, outgoing)
  if (interrupt === 'after-outgoing') throw new SkillContractError('skill-interrupt', 'after-outgoing')
}

export function restoreRetiredDirectory(dest: string, outgoing: string): void {
  if (!existsSync(dest) && existsSync(outgoing)) renameSync(outgoing, dest)
}

export function discardDir(target: string): void {
  rmSync(target, { recursive: true, force: true })
}

export function upsertRecord(index: SkillIndex, record: SkillRecord): SkillIndex {
  return {
    ...index,
    records: [...index.records.filter((item) => item.id !== record.id), record],
  }
}

export function listActiveSkillNames(layout: SkillStoreLayout): string[] {
  if (!existsSync(layout.active)) return []
  return readdirSync(layout.active).filter((name) => statSync(path.join(layout.active, name)).isDirectory()).sort()
}

export function listInterruptedSkillNames(layout: SkillStoreLayout): string[] {
  const names = new Set(listActiveSkillNames(layout))
  if (existsSync(layout.history)) {
    for (const entry of readdirSync(layout.history)) {
      if (entry.startsWith('outgoing-')) names.add(entry.slice('outgoing-'.length))
    }
  }
  if (existsSync(layout.staging)) {
    for (const entry of readdirSync(layout.staging)) {
      if (entry.startsWith('incoming-')) names.add(entry.replace(/^incoming-/, ''))
    }
  }
  return [...names].sort()
}
