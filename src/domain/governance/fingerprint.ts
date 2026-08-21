import { createHash } from 'node:crypto'
import type { ApprovalFingerprintInput, ApprovalSummary } from './types.js'
import type { CandidateDiff, CandidateRecord } from '../candidate/types.js'

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function approvalFingerprint(input: ApprovalFingerprintInput): string {
  return createHash('sha256').update(stable(input)).digest('hex')
}

export function approvalSummary(record: CandidateRecord, diff: CandidateDiff): ApprovalSummary {
  return {
    owner: record.owner,
    currentVersion: diff.baseVersion,
    candidateVersion: record.version,
    digest: record.digest ?? '',
    capabilities: diff.capabilities,
    permissions: diff.permissions,
    tools: diff.tools,
    services: diff.services,
    providers: diff.providers,
    runtimeSeams: diff.runtimeSeams,
    effects: diff.effects,
    secrets: record.manifest.secrets,
    configRequired: record.manifest.configRequired,
    validationPassed: record.validation?.passed === true && record.lifecycle === 'validated',
  }
}

export function fingerprintFromCandidate(record: CandidateRecord, diff: CandidateDiff): string {
  if (record.digest === undefined) throw new Error('candidate digest is required for approval fingerprint')
  return approvalFingerprint({
    candidateId: record.id,
    owner: record.owner,
    version: record.version,
    digest: record.digest,
    baseVersion: record.baseVersion,
    diff,
  })
}
