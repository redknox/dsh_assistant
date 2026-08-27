import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  OPERATOR_STATUS_SCHEMA_VERSION,
  parseOperatorSkills,
  parseOperatorStatus,
} from '../src/domain/self-extension/status.js'

const validStatus = {
  schemaVersion: OPERATOR_STATUS_SCHEMA_VERSION,
  mode: 'normal',
  registryGeneration: 3,
  active: ['core/runtime@0.4.0'],
  pendingCandidates: [],
  validation: ['candidate-1:validated'],
  approval: ['candidate-1:approved-for-exact-diff'],
  activationState: 'idle',
  lkgOwners: ['core/runtime@0.4.0'],
  restartRecoveryRequired: false,
  reasons: [],
  thirdPartyImported: 0,
  thirdPartyActive: 0,
  thirdPartyFailed: 0,
  skills: {
    profile: 'assistant',
    candidates: 0,
    active: [],
    disabled: [],
    failed: [],
    catalog: 'ok',
  },
  ignoredFutureField: 'not projected',
} as const

describe('operator status parsing', () => {
  it('normalizes a valid snapshot and strips unknown fields', () => {
    const parsed = parseOperatorStatus(validStatus)
    assert.ok(parsed)
    assert.equal(parsed.schemaVersion, OPERATOR_STATUS_SCHEMA_VERSION)
    assert.equal('ignoredFutureField' in parsed, false)
    assert.deepEqual(parsed.skills, validStatus.skills)
  })

  it('fails closed on missing, future, or malformed status schemas', () => {
    assert.equal(parseOperatorStatus({ ...validStatus, schemaVersion: undefined }), undefined)
    assert.equal(parseOperatorStatus({ ...validStatus, schemaVersion: OPERATOR_STATUS_SCHEMA_VERSION + 1 }), undefined)
    assert.equal(parseOperatorStatus({ ...validStatus, registryGeneration: -1 }), undefined)
    assert.equal(parseOperatorStatus({ ...validStatus, active: ['ok', 42] }), undefined)
    assert.equal(parseOperatorStatus({ ...validStatus, activationState: 'invented' }), undefined)
    assert.equal(parseOperatorStatus({ ...validStatus, reasons: Array.from({ length: 1_001 }, () => 'reason') }), undefined)
    assert.equal(parseOperatorStatus({ ...validStatus, lastFailure: 'x'.repeat(4_097) }), undefined)
    assert.equal(parseOperatorStatus({ ...validStatus, skills: { ...validStatus.skills, catalog: 'unknown' } }), undefined)
  })

  it('validates standalone legacy Skill health snapshots', () => {
    assert.deepEqual(parseOperatorSkills(validStatus.skills), validStatus.skills)
    assert.equal(parseOperatorSkills({ ...validStatus.skills, candidates: 0.5 }), undefined)
    assert.equal(parseOperatorSkills({ ...validStatus.skills, failed: 'none' }), undefined)
  })
})
