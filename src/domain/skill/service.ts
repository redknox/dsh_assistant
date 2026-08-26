import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { renderSkillContent } from '@deepseek-ai/dsh-skill'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { SkillAuthorityError, SkillContractError } from './errors.js'
import { digestSkillFiles, inspectSkillDirectory, parseSkillMarkdown, skillId, STRICT_SEMVER } from './bundle.js'
import {
  activeDir,
  atomicPublishDirectory,
  candidateDir,
  discardDir,
  ensureSkillStore,
  listActiveSkillNames,
  publishSkillFiles,
  readSkillIndex,
  skillStoreLayout,
  stagingDir,
  upsertRecord,
  writeSkillIndex,
  type SkillStoreLayout,
} from './store.js'
import type {
  SkillImportResult,
  SkillInspectSummary,
  SkillLifecycle,
  SkillProvenance,
  SkillRecord,
} from './types.js'

const DEFAULT_VERSION = '1.0.0'

export class SkillService {
  readonly layout: SkillStoreLayout
  private invalidate?: () => void

  constructor(homeRoot: string, profile: string, invalidate?: () => void) {
    this.layout = skillStoreLayout(homeRoot, profile)
    this.invalidate = invalidate
    ensureSkillStore(this.layout)
  }

  attachInvalidation(invalidate: () => void): void {
    this.invalidate = invalidate
  }

  list(): SkillRecord[] {
    return [...readSkillIndex(this.layout).records]
  }

  get(id: string): SkillRecord {
    const record = readSkillIndex(this.layout).records.find((item) => item.id === id)
    if (record === undefined) throw new SkillContractError('unknown-skill', `unknown skill candidate: ${id}`)
    return record
  }

  inspect(id: string): SkillInspectSummary {
    const record = this.get(id)
    return {
      name: record.name,
      version: record.version,
      profile: record.profile,
      lifecycle: record.lifecycle,
      sealed: record.sealed,
      digest: record.digest,
      provenance: record.provenance,
      invocation: record.invocation,
      validationPassed: record.validationPassed,
      reviewComplete: record.reviewComplete,
      resources: record.resources,
      description: record.description,
      whenToUse: record.whenToUse,
      baseVersion: record.baseVersion,
    }
  }

  create(input: { readonly name: string; readonly description: string; readonly body: string; readonly whenToUse?: string }): SkillRecord {
    const version = nextVersion(this.layout, input.name)
    const files = {
      'SKILL.md': skillMarkdown(input.name, input.description, input.body, input.whenToUse),
    }
    return this.publishCandidate({
      name: input.name,
      version,
      files,
      provenance: { kind: 'assistant-authored', origin: 'assistant' },
      lifecycle: 'drafted',
    })
  }

  importLocal(sourceDir: string): SkillImportResult {
    const inspected = inspectSkillDirectory(sourceDir, {
      version: hostVersionHint(sourceDir) ?? DEFAULT_VERSION,
      provenance: { kind: 'third-party', origin: 'import' },
    })
    const id = skillId(inspected.name, inspected.version)
    const existing = readSkillIndex(this.layout).records.find((item) => item.id === id)
    if (existing) {
      if (existing.digest === inspected.plannedDigest) {
        return {
          status: 'duplicate',
          candidateId: existing.id,
          name: existing.name,
          version: existing.version,
          provenance: existing.provenance,
          lifecycle: existing.lifecycle,
          sealed: existing.sealed,
          nextAction: 'validate',
        }
      }
      throw new SkillContractError('import-duplicate-conflict', `same name/version already imported with different bytes: ${id}`)
    }
    const record = this.publishCandidate({
      name: inspected.name,
      version: inspected.version,
      files: inspected.files,
      provenance: { kind: 'third-party', origin: 'import' },
      lifecycle: 'imported',
    })
    return {
      status: 'imported',
      candidateId: record.id,
      name: record.name,
      version: record.version,
      provenance: record.provenance,
      lifecycle: record.lifecycle,
      sealed: record.sealed,
      nextAction: 'validate',
    }
  }

  writeFile(id: string, relativePath: string, content: string): SkillRecord {
    const record = this.get(id)
    if (record.sealed) throw new SkillContractError('skill-sealed', 'editing a sealed skill creates a new revision')
    if (record.lifecycle === 'active') throw new SkillAuthorityError('active skills are not writable')
    const root = candidateDir(this.layout, id)
    const current = readBundleFiles(root)
    current[relativePath] = content
    if (relativePath === 'SKILL.md') parseSkillMarkdown(content)
    publishSkillFiles(root, current)
    return this.update(id, (item) => ({
      ...item,
      digest: digestSkillFiles(current),
      resources: Object.keys(current).filter((name) => name !== 'SKILL.md').sort(),
      description: parseSkillMarkdown(current['SKILL.md'] ?? '').description,
    }))
  }

  async validate(id: string): Promise<SkillRecord> {
    const record = this.get(id)
    const loaded = await loadThroughDshProvider(candidateDir(this.layout, id), record.name)
    if (loaded.name !== record.name) throw new SkillContractError('skill-name', 'DSH parser name does not match host identity')
    return this.update(id, (item) => ({
      ...item,
      lifecycle: 'validated',
      validationPassed: true,
      description: loaded.description,
      whenToUse: loaded.whenToUse,
    }))
  }

  seal(id: string): SkillRecord {
    const record = this.get(id)
    if (!record.validationPassed) throw new SkillContractError('not-validated', 'skill must be validated before seal')
    const digest = digestSkillFiles(readBundleFiles(candidateDir(this.layout, id)))
    return this.update(id, (item) => ({
      ...item,
      lifecycle: 'sealed',
      sealed: true,
      digest,
    }))
  }

  review(id: string): SkillRecord {
    const record = this.get(id)
    if (!record.sealed) throw new SkillContractError('not-sealed', 'skill must be sealed before independent review')
    return this.update(id, (item) => ({ ...item, lifecycle: 'review-complete', reviewComplete: true }))
  }

  requestApproval(id: string): { readonly fingerprint: string; readonly record: SkillRecord } {
    const record = this.get(id)
    if (!record.sealed) throw new SkillContractError('not-sealed', 'skill must be sealed before approval can be requested')
    if (!record.validationPassed) throw new SkillContractError('not-validated', 'skill must be validated before approval can be requested')
    if (!record.reviewComplete) throw new SkillContractError('review-required', 'independent review is required before approval can be requested')
    const fingerprint = fingerprintOf(record)
    const updated = this.update(id, (item) => ({
      ...item,
      lifecycle: 'approval-requested',
      approvalFingerprint: fingerprint,
      approvalDecision: 'approval-requested',
    }))
    return { fingerprint, record: updated }
  }

  approve(id: string, fingerprint: string): SkillRecord {
    const record = this.get(id)
    const expected = fingerprintOf(record)
    if (fingerprint !== expected) throw new SkillContractError('digest-mismatch', 'approval fingerprint does not match the exact skill revision')
    return this.update(id, (item) => ({
      ...item,
      lifecycle: 'approved',
      approvalDecision: 'approved-for-exact-diff',
      approvalFingerprint: expected,
    }))
  }

  activate(id: string): SkillRecord {
    const record = this.get(id)
    if (record.approvalDecision !== 'approved-for-exact-diff') {
      throw new SkillContractError('approval-required', 'skill approval does not activate; human activation is required')
    }
    if (fingerprintOf(record) !== record.approvalFingerprint) {
      throw new SkillContractError('digest-mismatch', 'stale skill approval cannot activate')
    }
    const source = candidateDir(this.layout, id)
    const files = readBundleFiles(source)
    if (digestSkillFiles(files) !== record.digest) {
      throw new SkillContractError('digest-mismatch', 'skill candidate bytes no longer match the sealed digest')
    }
    const previous = readSkillIndex(this.layout)
    const dest = activeDir(this.layout, record.name)
    const staging = stagingDir(this.layout, `active-${record.id}`)
    try {
      discardDir(staging)
      publishSkillFiles(staging, files)
      atomicPublishDirectory(staging, dest)
    } catch (error) {
      discardDir(staging)
      throw error
    }
    const next = this.update(id, (item) => ({ ...item, lifecycle: 'active' as SkillLifecycle }))
    const index = readSkillIndex(this.layout)
    const superseded = index.records.map((item) => (
      item.name === record.name && item.id !== record.id && item.lifecycle === 'active'
        ? { ...item, lifecycle: 'disabled' as SkillLifecycle }
        : item
    ))
    writeSkillIndex(this.layout, {
      ...index,
      records: superseded.some((item) => item.id === next.id) ? superseded : [...superseded, next],
      active: { ...index.active, [record.name]: record.version },
      lastActive: previous.active[record.name] !== undefined
        ? { name: record.name, version: previous.active[record.name]! }
        : index.lastActive,
    })
    this.invalidate?.()
    return this.get(id)
  }

  disable(name: string): void {
    const index = readSkillIndex(this.layout)
    const version = index.active[name]
    if (version === undefined) throw new SkillContractError('unknown-skill', `no active skill: ${name}`)
    const record = this.get(skillId(name, version))
    if (record.provenance.kind === 'system') throw new SkillAuthorityError('system skills cannot be uninstalled')
    discardDir(activeDir(this.layout, name))
    const { [name]: _removed, ...active } = index.active
    writeSkillIndex(this.layout, {
      ...index,
      active,
      lastActive: { name, version },
      records: index.records.map((item) => item.id === record.id ? { ...item, lifecycle: 'disabled' } : item),
    })
    this.invalidate?.()
  }

  uninstall(name: string, acknowledgedDependents: readonly string[] = []): void {
    const index = readSkillIndex(this.layout)
    const version = index.active[name] ?? index.records.find((item) => item.name === name)?.version
    if (version === undefined) throw new SkillContractError('unknown-skill', `unknown skill: ${name}`)
    const record = this.get(skillId(name, version))
    if (record.provenance.kind === 'system') throw new SkillAuthorityError('system skills cannot be uninstalled')
    if (record.dependents.length > 0 && !sameSet(record.dependents, acknowledgedDependents)) {
      throw new SkillContractError('dependents', `hard dependents must be acknowledged: ${record.dependents.join(', ')}`)
    }
    discardDir(activeDir(this.layout, name))
    const { [name]: _removed, ...active } = index.active
    writeSkillIndex(this.layout, {
      ...index,
      active,
      lastActive: { name, version },
      records: index.records.map((item) => item.name === name && item.lifecycle === 'active' ? { ...item, lifecycle: 'uninstalled' } : item),
    })
    this.invalidate?.()
  }

  reactivate(name: string, version: string): SkillRecord {
    return this.activate(skillId(name, version))
  }

  rollback(): SkillRecord | undefined {
    const index = readSkillIndex(this.layout)
    const prior = index.lastActive
    if (prior === undefined) throw new SkillContractError('no-rollback', 'no prior active skill revision')
    const record = this.get(skillId(prior.name, prior.version))
    if (record.approvalDecision !== 'approved-for-exact-diff') {
      throw new SkillContractError('approval-required', 'rollback target is not an approved skill revision')
    }
    return this.activate(record.id)
  }

  activeRoot(): string {
    return this.layout.active
  }

  catalogNames(): string[] {
    return listActiveSkillNames(this.layout)
  }

  private publishCandidate(input: {
    readonly name: string
    readonly version: string
    readonly files: Readonly<Record<string, string>>
    readonly provenance: SkillProvenance
    readonly lifecycle: SkillLifecycle
  }): SkillRecord {
    const id = skillId(input.name, input.version)
    const index = readSkillIndex(this.layout)
    const activeVersion = index.active[input.name]
    const parsed = parseSkillMarkdown(input.files['SKILL.md'] ?? '')
    const record: SkillRecord = {
      id,
      name: input.name,
      version: input.version,
      digest: digestSkillFiles(input.files),
      provenance: input.provenance,
      profile: this.layout.profile,
      lifecycle: input.lifecycle,
      invocation: parsed.invocation,
      sealed: false,
      validationPassed: false,
      reviewComplete: false,
      baseVersion: activeVersion !== undefined && activeVersion !== input.version ? activeVersion : undefined,
      resources: Object.keys(input.files).filter((name) => name !== 'SKILL.md').sort(),
      description: parsed.description,
      whenToUse: parsed.whenToUse,
      dependents: [],
    }
    const staging = stagingDir(this.layout, id)
    const finalDir = candidateDir(this.layout, id)
    try {
      discardDir(staging)
      publishSkillFiles(staging, input.files)
      atomicPublishDirectory(staging, finalDir)
      writeSkillIndex(this.layout, upsertRecord(index, record))
    } catch (error) {
      discardDir(staging)
      if (!index.records.some((item) => item.id === id)) discardDir(finalDir)
      throw error
    }
    return record
  }

  private update(id: string, map: (record: SkillRecord) => SkillRecord): SkillRecord {
    const index = readSkillIndex(this.layout)
    const current = index.records.find((item) => item.id === id)
    if (current === undefined) throw new SkillContractError('unknown-skill', `unknown skill candidate: ${id}`)
    const next = map(current)
    writeSkillIndex(this.layout, upsertRecord(index, next))
    return next
  }
}

function fingerprintOf(record: SkillRecord): string {
  return createHash('sha256').update(JSON.stringify({
    name: record.name,
    profile: record.profile,
    version: record.version,
    digest: record.digest,
    provenance: record.provenance,
    invocation: record.invocation,
    resources: record.resources,
    baseVersion: record.baseVersion ?? '',
  })).digest('hex')
}

function nextVersion(layout: SkillStoreLayout, name: string): string {
  const versions = readSkillIndex(layout).records.filter((item) => item.name === name).map((item) => item.version)
  if (versions.length === 0) return DEFAULT_VERSION
  const last = versions.sort().at(-1) ?? DEFAULT_VERSION
  const [major, minor, patch] = last.split('.').map(Number)
  return `${major}.${minor}.${(patch ?? 0) + 1}`
}

function hostVersionHint(sourceDir: string): string | undefined {
  const descriptor = path.join(sourceDir, 'tars-ng.skill.json')
  if (!existsSync(descriptor)) return undefined
  const raw = JSON.parse(readFileSync(descriptor, 'utf8')) as { version?: string }
  return typeof raw.version === 'string' && STRICT_SEMVER.test(raw.version) ? raw.version : undefined
}

function skillMarkdown(name: string, description: string, body: string, whenToUse?: string): string {
  const extra = whenToUse === undefined ? '' : `whenToUse: ${whenToUse}\n`
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body.endsWith('\n') ? body : `${body}\n`}`
}

function readBundleFiles(root: string): Record<string, string> {
  return inspectSkillDirectory(root, { version: DEFAULT_VERSION, provenance: { kind: 'third-party', origin: 'import' } }).files
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item))
}

export async function loadThroughDshProvider(skillDir: string, name: string): Promise<{
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly content: string
  readonly rendered: string
}> {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(skillFilesystem, {
    includeDefaultRoots: false,
    watch: false,
    watchFollowSymlinks: false,
    customSkillDirs: [skillDir],
  })
  try {
    const skill = await ctx.skills.get(name, { cwd: skillDir })
    if (skill === undefined) throw new SkillContractError('not-validated', `DSH skill provider could not load ${name}`)
    return {
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      content: skill.content,
      rendered: renderSkillContent(skill),
    }
  } finally {
    await ctx.fiber.dispose()
  }
}
