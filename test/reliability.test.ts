import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  CandidateService,
} from '../src/domain/candidate/index.js'
import {
  deriveRiskClass,
  evaluateReliability,
  googleCalendarReadRiskModel,
  googleCalendarWriteRiskModel,
  interpretTransportFailure,
  mayRetryWrite,
  obsidianVaultRiskModel,
  type RiskModel,
} from '../src/domain/reliability/index.js'
import {
  InMemoryRegistryPersistence,
  RegistryService,
  bootstrapCoreInventory,
} from '../src/domain/registry/index.js'
import type { ResolutionReview } from '../src/domain/resolution/index.js'

function review(overrides: Partial<ResolutionReview> = {}): ResolutionReview {
  return {
    kind: 'implement-provider',
    capability: 'calendar.events.create',
    need: 'create a calendar event',
    recommendation: 'Implement provider google on integrations.calendar.',
    rationale: 'Existing seam.',
    implications: [],
    assumptions: [],
    unresolved: [],
    steps: [],
    registryFacts: { exact: { kind: 'unknown', capability: 'calendar.events.create' }, domainOwners: [], conflicts: [] },
    target: { owner: 'managed/integrations', seam: 'integrations.calendar', provider: 'google' },
    ...overrides,
  }
}

function workspace() {
  const registry = new RegistryService(new InMemoryRegistryPersistence())
  bootstrapCoreInventory((input) => registry.register(input))
  return new CandidateService(registry, mkdtempSync(path.join(tmpdir(), 'dsh-rel-')))
}

function writeManifest(model?: RiskModel, extras: Record<string, unknown> = {}) {
  return {
    capabilities: ['calendar.events.create'],
    permissions: ['google.calendar.events.create'],
    secrets: ['google.calendar.oauth'],
    effects: { network: ['https://www.googleapis.com/calendar/v3'], secrets: ['google.calendar.oauth'] },
    riskModel: model,
    ...extras,
  }
}

describe('engineering reliability gate', () => {
  it('A. lets a low-risk capability pass with a synthesized R0 model', () => {
    const store = workspace()
    const created = store.create({
      review: review({ kind: 'new-plugin', capability: 'v02.probe.ping', need: 'probe', target: undefined }),
      owner: 'generated/v02-probe',
      version: '0.1.0',
      manifest: { capabilities: ['v02.probe.ping'] },
    })
    const report = store.validate(created.id)
    assert.equal(report.passed, true)
    assert.equal(report.reliability?.derivedClass, 'R0')
    assert.equal(report.reliability?.synthesized, true)
    assert.equal(report.stages.find((item) => item.name === 'reliability.gate')?.status, 'passed')
  })

  it('B. blocks a credentialed write that lacks reliability evidence', () => {
    const store = workspace()
    const created = store.create({
      review: review(),
      owner: 'generated/google-calendar',
      version: '0.2.0',
      manifest: writeManifest(),
    })
    const report = store.validate(created.id)
    assert.equal(report.passed, false)
    assert.equal(report.reliability?.derivedClass, 'R3')
    assert.equal(store.get(created.id).lifecycle, 'validation-failed')
    assert.match(report.stages.find((item) => item.name === 'reliability.gate')?.summary ?? '', /Risk Model/)
  })

  it('C. keeps an unknown transport outcome unknown', () => {
    assert.equal(interpretTransportFailure('unknown'), 'unknown')
    assert.notEqual(interpretTransportFailure('unknown'), 'not-applied')
    assert.equal(interpretTransportFailure('applied'), 'applied')
  })

  it('D. rejects blind write retry after timeout', () => {
    const model: RiskModel = { ...googleCalendarWriteRiskModel(), retryPolicy: { reads: 'bounded', writes: 'blind-on-timeout' } }
    const store = workspace()
    const created = store.create({
      review: review(),
      owner: 'generated/google-calendar',
      version: '0.2.0',
      manifest: writeManifest(model),
    })
    const report = store.validate(created.id)
    assert.equal(report.passed, false)
    assert.equal(report.reliability?.checks.some((item) => item.name === 'retry-policy-valid' && !item.passed), true)
    assert.equal(mayRetryWrite(model.retryPolicy, 'unknown'), false)
  })

  it('E. accepts deterministic provider identity plus independent reconciliation', () => {
    const result = evaluateReliability({
      owner: 'generated/google-calendar',
      version: '0.2.0',
      provenance: { kind: 'generated', origin: 'assistant' },
      resolutionKind: 'implement-provider',
      resolutionCapability: 'calendar.events.create',
      resolutionNeed: 'create',
      capabilities: ['calendar.events.create'],
      permissions: ['google.calendar.events.create'],
      runtimeSeams: ['integrations.calendar'],
      tools: [],
      services: [],
      providers: ['google'],
      secrets: ['google.calendar.oauth'],
      configRequired: [],
      effects: { filesystem: [], network: ['https://www.googleapis.com/calendar/v3'], process: [], secrets: ['google.calendar.oauth'], externalSystems: [] },
      entryPoints: [],
      validationTasks: [],
      riskModel: googleCalendarWriteRiskModel(),
    })
    assert.equal(result.derivedClass, 'R3')
    assert.equal(result.passed, true)
  })

  it('F. rejects reconciliation that reuses a cancelled context', () => {
    const model: RiskModel = {
      ...googleCalendarWriteRiskModel(),
      reconciliation: { strategy: 'read-after-uncertain-write', independentContext: false, cancelledContextReuse: true },
    }
    const store = workspace()
    const created = store.create({
      review: review(),
      owner: 'generated/google-calendar',
      version: '0.2.0',
      manifest: writeManifest(model),
    })
    assert.equal(store.validate(created.id).reliability?.checks.some((item) => item.name === 'idempotency-reconciliation-valid' && !item.passed), true)
  })

  it('G. rejects fixture-only idempotency as provider evidence', () => {
    const model: RiskModel = {
      ...googleCalendarWriteRiskModel(),
      idempotency: { strategy: 'fixture-only', contractKind: 'test-double', evidence: 'in-memory Map de-duplicates POSTs' },
    }
    const store = workspace()
    const created = store.create({
      review: review(),
      owner: 'generated/google-calendar',
      version: '0.2.0',
      manifest: writeManifest(model),
    })
    assert.equal(store.validate(created.id).reliability?.checks.some((item) => item.name === 'real-contract-evidence-present' && !item.passed), true)
  })

  it('H. rejects arbitrary network authority for a credentialed adapter', () => {
    const model: RiskModel = {
      ...googleCalendarWriteRiskModel(),
      trustBoundaries: { ...googleCalendarWriteRiskModel().trustBoundaries, candidateNetworkAuthority: 'arbitrary-fetch' },
    }
    const store = workspace()
    const created = store.create({
      review: review(),
      owner: 'generated/google-calendar',
      version: '0.2.0',
      manifest: writeManifest(model),
    })
    assert.equal(store.validate(created.id).reliability?.checks.some((item) => item.name === 'secret-safety-valid' && !item.passed), true)
  })

  it('I. treats reconciliation failure as explicit unknown, not a retry signal', () => {
    assert.equal(interpretTransportFailure('unknown'), 'unknown')
    assert.equal(mayRetryWrite({ reads: 'bounded', writes: 'never-on-unknown' }, 'unknown'), false)
  })

  it('J. rejects rollback that claims remote undo without compensation', () => {
    const model: RiskModel = {
      ...googleCalendarWriteRiskModel(),
      rollback: { runtimeUnmount: true, compensatesExternal: true },
    }
    const store = workspace()
    const created = store.create({
      review: review(),
      owner: 'generated/google-calendar',
      version: '0.2.0',
      manifest: writeManifest(model),
    })
    assert.equal(store.validate(created.id).reliability?.checks.some((item) => item.name === 'rollback-semantics-valid' && !item.passed), true)
    assert.equal(googleCalendarWriteRiskModel().rollback.compensatesExternal, false)
  })

  it('K. accepts the Google Calendar write lesson as a passing R3 model', () => {
    const store = workspace()
    const created = store.create({
      review: review(),
      owner: 'generated/google-calendar',
      version: '0.2.0',
      manifest: writeManifest(googleCalendarWriteRiskModel()),
    })
    const report = store.validate(created.id)
    assert.equal(report.passed, true, report.stages.find((item) => item.name === 'reliability.gate')?.summary)
    assert.equal(report.reliability?.derivedClass, 'R3')
    assert.equal(deriveRiskClass(store.get(created.id).manifest), 'R3')
    assert.equal(googleCalendarReadRiskModel().declaredClass, 'R1')
  })

  it('L. keeps local Obsidian mutation on the lighter R2 path', () => {
    const model = obsidianVaultRiskModel()
    assert.equal(model.declaredClass, 'R2')
    const store = workspace()
    const created = store.create({
      review: review({ kind: 'new-plugin', capability: 'obsidian.notes.create', need: 'vault', target: undefined }),
      owner: 'generated/obsidian-vault',
      version: '0.1.0',
      manifest: {
        capabilities: ['obsidian.notes.create'],
        permissions: ['filesystem.vault.write'],
        effects: { filesystem: ['/tmp/vault'] },
        riskModel: model,
      },
    })
    const report = store.validate(created.id)
    assert.equal(report.passed, true)
    assert.equal(report.reliability?.derivedClass, 'R2')
  })

  it('does not allow a candidate to self-downgrade its risk class', () => {
    const model: RiskModel = { ...googleCalendarWriteRiskModel(), declaredClass: 'R0' }
    const store = workspace()
    const created = store.create({
      review: review(),
      owner: 'generated/google-calendar',
      version: '0.2.0',
      manifest: writeManifest(model),
    })
    assert.equal(store.validate(created.id).reliability?.checks.some((item) => item.name === 'risk-class-consistent' && !item.passed), true)
  })
})
