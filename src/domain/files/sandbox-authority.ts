import type { CapabilityClaim, CapabilityRegistry, RegistryRecord } from '../registry/types.js'

const FILE_TASK_CLAIMS = {
  'files.read': { fake: 'local.fake.files.read', sandbox: 'local.sandbox.files.read' },
  'files.write': { fake: 'local.fake.files.write', sandbox: 'local.sandbox.files.write' },
  'files.delete': { fake: 'local.fake.files.delete', sandbox: 'local.sandbox.files.delete' },
  'tasks.read': { fake: 'local.fake.tasks.read', sandbox: 'local.sandbox.tasks.read' },
  'tasks.propose': { fake: 'local.fake.tasks.propose', sandbox: 'local.sandbox.tasks.propose' },
  'tasks.create': { fake: 'local.fake.tasks.create', sandbox: 'local.sandbox.tasks.create' },
} as const

export const SANDBOX_PERMISSIONS = Object.values(FILE_TASK_CLAIMS).map((item) => item.sandbox)

function unique(items: readonly string[]): string[] {
  return [...new Set(items)]
}

function claimPermissions(claim: CapabilityClaim, live: boolean): readonly string[] {
  const mapped = FILE_TASK_CLAIMS[claim.id as keyof typeof FILE_TASK_CLAIMS]
  if (!mapped) return [...claim.permissions]
  return [live ? mapped.sandbox : mapped.fake]
}

export function integrationsAuthorityForSandbox(record: RegistryRecord, live: boolean): {
  readonly capabilities: readonly CapabilityClaim[]
  readonly permissions: readonly string[]
  readonly providers: readonly string[]
} {
  const capabilities = record.capabilities.map((claim) => ({
    id: claim.id,
    permissions: claimPermissions(claim, live),
  }))
  const keep = record.permissions.filter((item) => (
    item !== 'local.fake.suite'
    && !item.startsWith('local.sandbox.')
    && !item.startsWith('local.fake.files.')
    && !item.startsWith('local.fake.tasks.')
  ))
  const permissions = live
    ? unique([...keep, ...SANDBOX_PERMISSIONS])
    : unique([...keep, 'local.fake.suite'])
  const providers = live
    ? unique([...record.providers.filter((item) => item !== 'sandbox'), 'fake', 'sandbox'])
    : unique([...record.providers.filter((item) => item !== 'sandbox'), 'fake'])
  return { capabilities, permissions, providers }
}

function sameAuthority(record: RegistryRecord, next: ReturnType<typeof integrationsAuthorityForSandbox>): boolean {
  return JSON.stringify({
    capabilities: record.capabilities,
    permissions: record.permissions,
    providers: record.providers,
  }) === JSON.stringify(next)
}

/** Stamp live sandbox claims on managed integrations. Never uses host.* names. */
export function applySandboxAuthorityStamp(registry: CapabilityRegistry, live: boolean): void {
  const records = registry.list({ owner: 'managed/integrations' }).filter((record) => (
    record.provenance.kind === 'managed' && record.provenance.origin === 'human'
  ))
  for (const record of records) {
    const next = integrationsAuthorityForSandbox(record, live)
    if (sameAuthority(record, next)) continue
    registry.revise(record.owner, record.version, next)
  }
}
