import { HOST_CONTROL_BOUNDARIES } from './defaults.js'
import type { RiskModel } from './types.js'
import { ADVERSARIAL_SCENARIOS } from './types.js'

const ALL_COVERED = [...ADVERSARIAL_SCENARIOS]

export function googleCalendarReadRiskModel(): RiskModel {
  return {
    capability: 'calendar.read',
    declaredClass: 'R1',
    externalSystems: ['google-calendar-v3'],
    trustBoundaries: {
      ...HOST_CONTROL_BOUNDARIES,
      candidateNetworkAuthority: 'host-managed-bounded-transport',
    },
    sideEffects: [{ action: 'calendar.events.list', outcomes: ['not-applied'] }],
    credentialBoundaries: ['google.calendar.oauth'],
    networkBoundaries: ['https://www.googleapis.com/calendar/v3'],
    persistence: [],
    failureModes: ['auth-failure', 'rate-limit', 'provider-5xx', 'input-invalid', 'credential-expired'],
    uncertainOutcomes: [],
    retryPolicy: { reads: 'bounded', writes: 'never-on-unknown', budget: 2 },
    idempotency: {
      strategy: 'none',
      contractKind: 'real-provider-contract',
      evidence: 'Read-only Calendar list/get; Google Calendar API v3. Fixture doubles simulate v3, they do not define it.',
    },
    reconciliation: { strategy: 'not-applicable', independentContext: true, cancelledContextReuse: false },
    rollback: { runtimeUnmount: true, compensatesExternal: false },
    observability: ['typed-provider-errors', 'no-secret-in-diagnostics'],
    validationScenarios: ['happy-path', 'credential-failure', 'rate-limit'],
    omittedScenarios: ADVERSARIAL_SCENARIOS
      .filter((item) => !['happy-path', 'credential-failure', 'rate-limit'].includes(item))
      .map((scenario) => ({ scenario, reason: 'Read-only Calendar surface; no remote mutation.' })),
    unresolvedRisks: [],
  }
}

export function googleCalendarWriteRiskModel(): RiskModel {
  return {
    capability: 'calendar.events.create',
    declaredClass: 'R3',
    externalSystems: ['google-calendar-v3'],
    trustBoundaries: {
      ...HOST_CONTROL_BOUNDARIES,
      candidateNetworkAuthority: 'host-managed-bounded-transport',
    },
    sideEffects: [{ action: 'calendar.events.create', outcomes: ['not-applied', 'applied', 'unknown', 'reconciled'] }],
    credentialBoundaries: ['google.calendar.oauth'],
    networkBoundaries: ['https://www.googleapis.com/calendar/v3'],
    persistence: [],
    failureModes: [
      'input-invalid',
      'permission-denied',
      'auth-failure',
      'provider-4xx',
      'rate-limit',
      'provider-5xx',
      'timeout-before-side-effect',
      'timeout-after-side-effect',
      'caller-cancelled',
      'duplicate-request',
      'reconciliation-failed',
      'credential-expired',
      'stale-state',
      'restart-during-operation',
    ],
    uncertainOutcomes: ['timeout-after-possible-insert', 'abort-after-remote-insert'],
    retryPolicy: { reads: 'bounded', writes: 'never-on-unknown' },
    idempotency: {
      strategy: 'deterministic-resource-id',
      contractKind: 'real-provider-contract',
      evidence: 'Google Calendar events.insert accepts a client-supplied event id; SHA-256 of the operation key is a valid base32hex subset. GET-before-insert and GET-after-uncertain-write are Calendar v3 reads, not fixture Map de-duplication.',
    },
    reconciliation: {
      strategy: 'read-after-uncertain-write',
      independentContext: true,
      cancelledContextReuse: false,
    },
    rollback: { runtimeUnmount: true, compensatesExternal: false },
    observability: ['typed-provider-errors', 'no-secret-in-diagnostics', 'reconciliation-outcome'],
    validationScenarios: ALL_COVERED,
    omittedScenarios: [],
    unresolvedRisks: ['Live Calendar writes are not exercised in CI without operator credentials.'],
  }
}

export function obsidianVaultRiskModel(): RiskModel {
  return {
    capability: 'obsidian.notes.create',
    declaredClass: 'R2',
    externalSystems: [],
    trustBoundaries: {
      ...HOST_CONTROL_BOUNDARIES,
      filesystemAuthority: 'confined-vault-root',
    },
    sideEffects: [{ action: 'obsidian.notes.create', outcomes: ['not-applied', 'applied'] }],
    credentialBoundaries: [],
    networkBoundaries: [],
    persistence: ['vault-root'],
    failureModes: ['input-invalid', 'permission-denied', 'local-persistence-failure'],
    uncertainOutcomes: [],
    retryPolicy: { reads: 'none', writes: 'never-on-unknown' },
    idempotency: { strategy: 'none', contractKind: 'not-applicable', evidence: 'Local confined-root writes; no remote provider contract.' },
    reconciliation: { strategy: 'not-applicable', independentContext: true, cancelledContextReuse: false },
    rollback: { runtimeUnmount: true, compensatesExternal: false },
    observability: ['validation-report'],
    validationScenarios: ['happy-path', 'fail-before-side-effect', 'restart-boundary', 'rollback-interaction'],
    omittedScenarios: ADVERSARIAL_SCENARIOS
      .filter((item) => !['happy-path', 'fail-before-side-effect', 'restart-boundary', 'rollback-interaction'].includes(item))
      .map((scenario) => ({ scenario, reason: 'Local vault IO has no credentialed remote mutation.' })),
    unresolvedRisks: [],
  }
}
