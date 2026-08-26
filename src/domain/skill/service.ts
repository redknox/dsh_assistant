import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { renderSkillContent } from '@deepseek-ai/dsh-skill'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { TrustedAuthorityCredential } from '../governance/types.js'
import { REVIEW_POLICY_VERSION, type IndependentReview, type ReviewPackage, type ReviewReport } from '../review/types.js'
import { SkillAuthorityError, SkillContractError } from './errors.js'
import {
  applyHostSkillLimits,
  digestSkillFiles,
  nextSkillVersion,
  parseDependsOn,
  readAllowlistedSkillFiles,
  readHostSkillDescriptor,
  skillId,
  STRICT_SEMVER,
} from './bundle.js'
import {
  activeDir,
  atomicPublishDirectory,
  candidateDir,
  discardDir,
  ensureSkillStore,
  incomingDir,
  listInterruptedSkillNames,
  outgoingDir,
  publishSkillFiles,
  readSkillIndex,
  replaceActiveDirectory,
  restoreRetiredDirectory,
  retireActiveDirectory,
  skillStoreLayout,
  stagingDir,
  upsertRecord,
  writeSkillIndex,
  type SkillStoreLayout,
} from './store.js'
import type {
  SkillApprovalRecord,
  SkillDependency,
  SkillImportResult,
  SkillInspectSummary,
  SkillInvocationPolicy,
  SkillLifecycle,
  SkillProvenance,
  SkillRecord,
  SkillReviewRecord,
} from './types.js'

const DEFAULT_VERSION = '1.0.0'
const DEFAULT_INVOCATION: SkillInvocationPolicy = { modelInvocable: true, userInvocable: true }

export type SkillInterrupt = 'after-outgoing' | 'after-incoming' | 'after-index'

export class SkillService {
  readonly layout: SkillStoreLayout
  interruptAfter?: SkillInterrupt
  private invalidate?: () => void
  private rootId?: symbol
  private review?: IndependentReview

  constructor(homeRoot: string, profile: string, invalidate?: () => void) {
    this.layout = skillStoreLayout(homeRoot, profile)
    this.invalidate = invalidate
    ensureSkillStore(this.layout)
    this.recoverInterrupted()
    this.preflightActiveCatalog()
  }

  bindRoot(rootId: symbol): void {
    this.rootId = rootId
  }

  bindReview(review: IndependentReview): void {
    if (this.review !== undefined) {
      throw new SkillAuthorityError('independent review is already bound to this skill store')
    }
    this.review = review
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
      dependsOn: record.dependsOn ?? [],
      dependents: this.dependentsOf(record.name, record.version),
    }
  }

  listFiles(id: string): readonly string[] {
    return Object.keys(this.readCandidateFiles(id)).sort()
  }

  readFile(id: string, relativePath: string): string {
    const content = this.readCandidateFiles(id)[relativePath]
    if (content === undefined) throw new SkillContractError('skill-boundary', `unknown skill file: ${relativePath}`)
    return content
  }

  create(input: {
    readonly name: string
    readonly description: string
    readonly body: string
    readonly whenToUse?: string
    readonly dependsOn?: readonly SkillDependency[]
  }): SkillRecord {
    applyHostSkillLimits({ name: input.name, description: input.description, content: input.body })
    const version = nextVersion(this.layout, input.name)
    return this.publishCandidate({
      name: input.name,
      version,
      files: { 'SKILL.md': skillMarkdown(input.name, input.description, input.body, input.whenToUse) },
      provenance: { kind: 'assistant-authored', origin: 'assistant' },
      lifecycle: 'drafted',
      invocation: DEFAULT_INVOCATION,
      description: input.description,
      whenToUse: input.whenToUse,
      dependsOn: parseDependsOn(input.dependsOn),
    })
  }

  async importLocal(sourceDir: string): Promise<SkillImportResult> {
    const files = readAllowlistedSkillFiles(sourceDir)
    const loaded = await loadThroughDshCatalog(sourceDir)
    applyHostSkillLimits(loaded)
    const descriptor = readHostSkillDescriptor(sourceDir)
    const version = descriptor.version ?? DEFAULT_VERSION
    if (!STRICT_SEMVER.test(version)) throw new SkillContractError('skill-version', `invalid skill version: ${version}`)
    const plannedDigest = digestSkillFiles(files)
    const id = skillId(loaded.name, version)
    const existing = readSkillIndex(this.layout).records.find((item) => item.id === id)
    if (existing) {
      if (existing.digest === plannedDigest) {
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
      name: loaded.name,
      version,
      files,
      provenance: { kind: 'third-party', origin: 'import' },
      lifecycle: 'imported',
      invocation: loaded.invocation,
      description: loaded.description,
      whenToUse: loaded.whenToUse,
      dependsOn: descriptor.dependsOn,
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
    const current = this.readCandidateFiles(id)
    current[relativePath] = content
    if (relativePath === 'SKILL.md') applyHostSkillLimits({
      name: record.name,
      description: record.description,
      content,
    })
    if (record.sealed || record.lifecycle === 'active') {
      return this.publishCandidate({
        name: record.name,
        version: nextVersion(this.layout, record.name),
        files: current,
        provenance: record.provenance.kind === 'system' ? record.provenance : { kind: 'assistant-authored', origin: 'assistant' },
        lifecycle: 'drafted',
        invocation: record.invocation,
        description: record.description,
        whenToUse: record.whenToUse,
        baseVersion: record.version,
        dependsOn: record.dependsOn ?? [],
      })
    }
    publishSkillFiles(candidateDir(this.layout, id), current)
    return this.update(id, (item) => ({
      ...item,
      digest: digestSkillFiles(current),
      resources: Object.keys(current).filter((name) => name !== 'SKILL.md').sort(),
    }))
  }

  async validate(id: string): Promise<SkillRecord> {
    const record = this.get(id)
    const loaded = await loadThroughDshCatalog(candidateDir(this.layout, id))
    if (loaded.name !== record.name) throw new SkillContractError('skill-name', 'DSH parser name does not match host identity')
    applyHostSkillLimits(loaded)
    return this.update(id, (item) => ({
      ...item,
      lifecycle: 'validated',
      validationPassed: true,
      description: loaded.description,
      whenToUse: loaded.whenToUse,
      invocation: loaded.invocation,
    }))
  }

  seal(id: string): SkillRecord {
    const record = this.get(id)
    if (!record.validationPassed) throw new SkillContractError('not-validated', 'skill must be validated before seal')
    const digest = digestSkillFiles(this.readCandidateFiles(id))
    return this.update(id, (item) => ({
      ...item,
      lifecycle: 'sealed',
      sealed: true,
      digest,
    }))
  }

  requestReview(id: string): { readonly record: SkillRecord; readonly report: ReviewReport } {
    const record = this.get(id)
    if (!record.sealed) throw new SkillContractError('not-sealed', 'skill must be sealed before independent review')
    if (!record.validationPassed) throw new SkillContractError('not-validated', 'skill must be validated before independent review')
    const report = this.requireReview().review(skillReviewPackage(record))
    const complete = report.state === 'review-complete' && report.digest === record.digest
    const stored: SkillReviewRecord = {
      candidateId: record.id,
      digest: record.digest,
      state: complete ? 'review-complete' : 'changes-required',
      createdAt: new Date().toISOString(),
    }
    const updated = this.update(id, (item) => ({
      ...item,
      lifecycle: complete ? 'review-complete' : item.lifecycle,
      reviewComplete: complete,
    }))
    const index = readSkillIndex(this.layout)
    writeSkillIndex(this.layout, {
      ...index,
      reviews: [...(index.reviews ?? []).filter((item) => item.candidateId !== record.id || item.digest !== record.digest), stored],
    })
    return { record: this.get(id), report }
  }

  requestApproval(id: string): { readonly fingerprint: string; readonly record: SkillRecord } {
    const record = this.get(id)
    if (!record.sealed) throw new SkillContractError('not-sealed', 'skill must be sealed before approval can be requested')
    if (!record.validationPassed) throw new SkillContractError('not-validated', 'skill must be validated before approval can be requested')
    const stored = (readSkillIndex(this.layout).reviews ?? []).find((item) => (
      item.candidateId === record.id && item.digest === record.digest && item.state === 'review-complete'
    ))
    if (stored === undefined) {
      throw new SkillContractError('review-required', 'independent review is required before approval can be requested')
    }
    const fingerprint = fingerprintOf(record)
    const updated = this.update(id, (item) => ({
      ...item,
      lifecycle: 'approval-requested',
      approvalFingerprint: fingerprint,
      approvalDecision: 'approval-requested',
    }))
    return { fingerprint, record: updated }
  }

  approve(id: string, fingerprint: string, credential: TrustedAuthorityCredential): SkillRecord {
    this.assertTrusted(credential)
    const record = this.get(id)
    const expected = fingerprintOf(record)
    if (fingerprint !== expected) throw new SkillContractError('digest-mismatch', 'approval fingerprint does not match the exact skill revision')
    const approval: SkillApprovalRecord = {
      id: randomUUID(),
      skillId: record.id,
      fingerprint: expected,
      decision: 'approved-for-exact-diff',
      authority: credential.authority,
      createdAt: new Date().toISOString(),
      digest: record.digest,
      resources: record.resources,
    }
    const next = {
      ...record,
      lifecycle: 'approved' as SkillLifecycle,
      approvalDecision: 'approved-for-exact-diff' as const,
      approvalFingerprint: expected,
    }
    const index = readSkillIndex(this.layout)
    writeSkillIndex(this.layout, {
      ...upsertRecord(index, next),
      approvals: [...(index.approvals ?? []), approval],
    })
    return next
  }

  activate(id: string, credential: TrustedAuthorityCredential): SkillRecord {
    this.assertTrusted(credential)
    const record = this.get(id)
    if (record.approvalDecision !== 'approved-for-exact-diff') {
      throw new SkillContractError('approval-required', 'skill approval does not activate; human activation is required')
    }
    if (fingerprintOf(record) !== record.approvalFingerprint) {
      throw new SkillContractError('digest-mismatch', 'stale skill approval cannot activate')
    }
    const files = this.readCandidateFiles(id)
    if (digestSkillFiles(files) !== record.digest) {
      throw new SkillContractError('digest-mismatch', 'skill candidate bytes no longer match the sealed digest')
    }
    const previous = readSkillIndex(this.layout)
    const dest = activeDir(this.layout, record.name)
    const incoming = incomingDir(this.layout, record.name)
    const outgoing = outgoingDir(this.layout, record.name)
    try {
      discardDir(incoming)
      publishSkillFiles(incoming, files)
      replaceActiveDirectory({
        incoming,
        dest,
        outgoing,
        interrupt: this.interruptAfter === 'after-outgoing' || this.interruptAfter === 'after-incoming'
          ? this.interruptAfter
          : undefined,
      })
    } catch (error) {
      if (error instanceof SkillContractError && error.code === 'skill-interrupt') throw error
      discardDir(incoming)
      restoreRetiredDirectory(dest, outgoing)
      throw error
    }
    const next = { ...record, lifecycle: 'active' as SkillLifecycle }
    const committed = {
      ...previous,
      records: previous.records.map((item) => (
        item.id === next.id
          ? next
          : item.name === record.name && item.lifecycle === 'active'
            ? { ...item, lifecycle: 'disabled' as SkillLifecycle }
            : item
      )),
      active: { ...previous.active, [record.name]: record.version },
      lastActive: previous.active[record.name] !== undefined
        ? { name: record.name, version: previous.active[record.name]! }
        : previous.lastActive,
    }
    if (!committed.records.some((item) => item.id === next.id)) committed.records = [...committed.records, next]
    try {
      if (this.interruptAfter === 'after-index') throw new SkillContractError('skill-interrupt', 'after-index')
      writeSkillIndex(this.layout, committed)
    } catch (error) {
      if (!(error instanceof SkillContractError && error.code === 'skill-interrupt')) {
        restoreRetiredDirectory(dest, outgoing)
      }
      throw error
    }
    discardDir(outgoing)
    this.invalidate?.()
    return this.get(id)
  }

  disable(name: string, credential: TrustedAuthorityCredential): void {
    this.assertTrusted(credential)
    const index = readSkillIndex(this.layout)
    const version = index.active[name]
    if (version === undefined) throw new SkillContractError('unknown-skill', `no active skill: ${name}`)
    const record = this.get(skillId(name, version))
    if (record.provenance.kind === 'system') throw new SkillAuthorityError('system skills cannot be uninstalled')
    this.retireActive(name, version, 'disabled')
  }

  uninstall(name: string, credential: TrustedAuthorityCredential, acknowledgedDependents: readonly string[] = []): void {
    this.assertTrusted(credential)
    const index = readSkillIndex(this.layout)
    const version = index.active[name] ?? index.records.find((item) => item.name === name)?.version
    if (version === undefined) throw new SkillContractError('unknown-skill', `unknown skill: ${name}`)
    const record = this.get(skillId(name, version))
    if (record.provenance.kind === 'system') throw new SkillAuthorityError('system skills cannot be uninstalled')
    const dependents = this.dependentsOf(name, version)
    if (dependents.length > 0 && !sameSet(dependents, acknowledgedDependents)) {
      throw new SkillContractError('dependents', `hard dependents must be acknowledged: ${dependents.join(', ')}`)
    }
    if (index.active[name] !== undefined) this.retireActive(name, version, 'uninstalled')
    else {
      writeSkillIndex(this.layout, {
        ...index,
        records: index.records.map((item) => item.name === name ? { ...item, lifecycle: 'uninstalled' } : item),
      })
    }
  }

  reactivate(name: string, version: string, credential: TrustedAuthorityCredential): SkillRecord {
    return this.activate(skillId(name, version), credential)
  }

  rollback(credential: TrustedAuthorityCredential): SkillRecord | undefined {
    this.assertTrusted(credential)
    const index = readSkillIndex(this.layout)
    const prior = index.lastActive
    if (prior === undefined) throw new SkillContractError('no-rollback', 'no prior active skill revision')
    const record = this.get(skillId(prior.name, prior.version))
    if (record.approvalDecision !== 'approved-for-exact-diff') {
      throw new SkillContractError('approval-required', 'rollback target is not an approved skill revision')
    }
    return this.activate(record.id, credential)
  }

  approvals(): readonly SkillApprovalRecord[] {
    return readSkillIndex(this.layout).approvals ?? []
  }

  activeRoot(): string {
    return this.layout.active
  }

  catalogNames(): string[] {
    return Object.keys(readSkillIndex(this.layout).active).sort()
  }

  health(): {
    readonly candidates: number
    readonly active: readonly string[]
    readonly disabled: readonly string[]
    readonly failed: readonly string[]
  } {
    const records = this.list()
    return {
      candidates: records.filter((item) => item.lifecycle !== 'active' && item.lifecycle !== 'uninstalled').length,
      active: records.filter((item) => item.lifecycle === 'active').map((item) => item.id),
      disabled: records.filter((item) => item.lifecycle === 'disabled').map((item) => item.id),
      failed: [],
    }
  }

  private retireActive(name: string, version: string, lifecycle: 'disabled' | 'uninstalled'): void {
    const dest = activeDir(this.layout, name)
    const outgoing = outgoingDir(this.layout, name)
    const index = readSkillIndex(this.layout)
    try {
      retireActiveDirectory(dest, outgoing, this.interruptAfter === 'after-outgoing' ? 'after-outgoing' : undefined)
    } catch (error) {
      restoreRetiredDirectory(dest, outgoing)
      throw error
    }
    const { [name]: _removed, ...active } = index.active
    const committed = {
      ...index,
      active,
      lastActive: { name, version },
      records: index.records.map((item) => (
        item.name === name && (item.lifecycle === 'active' || item.id === skillId(name, version))
          ? { ...item, lifecycle }
          : item
      )),
    }
    try {
      if (this.interruptAfter === 'after-index') throw new SkillContractError('skill-interrupt', 'after-index')
      writeSkillIndex(this.layout, committed)
    } catch (error) {
      restoreRetiredDirectory(dest, outgoing)
      throw error
    }
    discardDir(outgoing)
    this.invalidate?.()
  }

  private recoverInterrupted(): void {
    for (const name of listInterruptedSkillNames(this.layout)) {
      const dest = activeDir(this.layout, name)
      const outgoing = outgoingDir(this.layout, name)
      const incoming = incomingDir(this.layout, name)
      const index = readSkillIndex(this.layout)
      if (!existsSync(dest) && existsSync(outgoing)) restoreRetiredDirectory(dest, outgoing)
      if (existsSync(dest) && existsSync(incoming)) discardDir(incoming)
      if (existsSync(dest) && existsSync(outgoing)) {
        const version = index.active[name]
        const record = version === undefined ? undefined : index.records.find((item) => item.id === skillId(name, version))
        if (record !== undefined && digestSkillFiles(readAllowlistedSkillFiles(dest)) !== record.digest) {
          discardDir(dest)
          restoreRetiredDirectory(dest, outgoing)
        } else {
          discardDir(outgoing)
        }
      }
      if (existsSync(dest) && index.active[name] === undefined) {
        discardDir(dest)
      }
    }
  }

  private preflightActiveCatalog(): void {
    const index = readSkillIndex(this.layout)
    for (const [name, version] of Object.entries(index.active)) {
      const record = index.records.find((item) => item.id === skillId(name, version))
      if (record === undefined) {
        throw new SkillContractError('skill-integrity', `active skill ${name} is missing a committed record`)
      }
      if (record.approvalDecision !== 'approved-for-exact-diff' || record.approvalFingerprint !== fingerprintOf(record)) {
        throw new SkillContractError('skill-integrity', `active skill ${name} is missing committed authority`)
      }
      const dest = activeDir(this.layout, name)
      if (!existsSync(dest)) {
        throw new SkillContractError('skill-integrity', `active skill artifact is missing: ${name}`)
      }
      if (digestSkillFiles(readAllowlistedSkillFiles(dest)) !== record.digest) {
        throw new SkillContractError('skill-integrity', `active skill artifact digest mismatch: ${name}`)
      }
    }
  }

  declareDependencies(id: string, dependsOn: readonly SkillDependency[]): SkillRecord {
    const record = this.get(id)
    const parsed = parseDependsOn(dependsOn)
    if (record.sealed || record.lifecycle === 'active') {
      return this.publishCandidate({
        name: record.name,
        version: nextVersion(this.layout, record.name),
        files: this.readCandidateFiles(id),
        provenance: record.provenance,
        lifecycle: 'drafted',
        invocation: record.invocation,
        description: record.description,
        whenToUse: record.whenToUse,
        baseVersion: record.version,
        dependsOn: parsed,
      })
    }
    return this.update(id, (item) => ({ ...item, dependsOn: parsed }))
  }

  private dependentsOf(name: string, version: string): string[] {
    return readSkillIndex(this.layout).records
      .filter((item) => (
        item.lifecycle !== 'uninstalled'
        && (item.dependsOn ?? []).some((dep) => dep.name === name && dep.version === version)
      ))
      .map((item) => item.id)
      .sort()
  }

  private readCandidateFiles(id: string): Record<string, string> {
    return readAllowlistedSkillFiles(candidateDir(this.layout, this.get(id).id))
  }

  private publishCandidate(input: {
    readonly name: string
    readonly version: string
    readonly files: Readonly<Record<string, string>>
    readonly provenance: SkillProvenance
    readonly lifecycle: SkillLifecycle
    readonly invocation: SkillInvocationPolicy
    readonly description: string
    readonly whenToUse?: string
    readonly baseVersion?: string
    readonly dependsOn?: readonly SkillDependency[]
  }): SkillRecord {
    const id = skillId(input.name, input.version)
    const index = readSkillIndex(this.layout)
    const activeVersion = index.active[input.name]
    const record: SkillRecord = {
      id,
      name: input.name,
      version: input.version,
      digest: digestSkillFiles(input.files),
      provenance: input.provenance,
      profile: this.layout.profile,
      lifecycle: input.lifecycle,
      invocation: input.invocation,
      sealed: false,
      validationPassed: false,
      reviewComplete: false,
      baseVersion: input.baseVersion ?? (activeVersion !== undefined && activeVersion !== input.version ? activeVersion : undefined),
      resources: Object.keys(input.files).filter((name) => name !== 'SKILL.md').sort(),
      description: input.description,
      whenToUse: input.whenToUse,
      dependsOn: input.dependsOn ?? [],
      dependents: this.dependentsOf(input.name, input.version),
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

  private requireReview(): IndependentReview {
    if (this.review === undefined) {
      throw new SkillAuthorityError('independent review is not bound to the skill store')
    }
    return this.review
  }

  private assertTrusted(credential: TrustedAuthorityCredential): void {
    if (
      this.rootId === undefined
      || !(credential instanceof TrustedAuthorityCredential)
      || !credential.issuedBy(this.rootId)
    ) {
      throw new SkillAuthorityError('skill authority requires a credential issued by the recovery root')
    }
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
    dependsOn: record.dependsOn ?? [],
    baseVersion: record.baseVersion ?? '',
  })).digest('hex')
}

function nextVersion(layout: SkillStoreLayout, name: string): string {
  return nextSkillVersion(readSkillIndex(layout).records.filter((item) => item.name === name).map((item) => item.version))
}

function skillMarkdown(name: string, description: string, body: string, whenToUse?: string): string {
  const extra = whenToUse === undefined ? '' : `whenToUse: ${whenToUse}\n`
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${body.endsWith('\n') ? body : `${body}\n`}`
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item))
}

export function skillReviewPackage(record: SkillRecord): ReviewPackage {
  return {
    policyVersion: REVIEW_POLICY_VERSION,
    candidate: {
      id: record.id,
      owner: `skill/${record.name}`,
      version: record.version,
      digest: record.digest,
      sealed: record.sealed,
    },
    riskClass: 'R0',
    validationPassed: record.validationPassed,
    validationStages: [{ name: 'dsh-skill-parse', status: record.validationPassed ? 'passed' : 'failed' }],
    permissionDiff: { added: [] },
    effectDiff: { kind: 'skill-instruction', resources: record.resources },
    generated: record.provenance.kind !== 'system',
    priorFindings: [],
  }
}

export async function loadThroughDshCatalog(skillDir: string): Promise<{
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly content: string
  readonly rendered: string
  readonly invocation: SkillInvocationPolicy
  readonly metadata?: Readonly<Record<string, unknown>>
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
    const listed = await ctx.skills.list({ cwd: skillDir })
    if (listed.length !== 1) {
      throw new SkillContractError('not-validated', 'DSH skill provider could not load exactly one skill from the bundle')
    }
    const skill = await ctx.skills.get(listed[0]!.name, { cwd: skillDir })
    if (skill === undefined) throw new SkillContractError('not-validated', `DSH skill provider could not load ${listed[0]!.name}`)
    return {
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      content: skill.content,
      rendered: renderSkillContent(skill),
      invocation: {
        modelInvocable: skill.invocation?.modelInvocable !== false,
        userInvocable: skill.invocation?.userInvocable !== false,
      },
      metadata: skill.metadata,
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

export async function loadThroughDshProvider(skillDir: string, name: string): Promise<{
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly content: string
  readonly rendered: string
}> {
  const loaded = await loadThroughDshCatalog(skillDir)
  if (loaded.name !== name) throw new SkillContractError('skill-name', 'DSH parser name does not match host identity')
  return loaded
}

