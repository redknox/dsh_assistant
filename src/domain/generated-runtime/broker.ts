import type { GeneratedBrokerRequest } from './types.js'

const HOST_TEXT_ECHO = 'host.text.echo'

export class GeneratedBrokerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GeneratedBrokerError'
  }
}

/** Host-owned broker. Unknown operations and undeclared permissions fail closed. */
export function assertBrokerAllowed(request: GeneratedBrokerRequest, approved: readonly string[]): void {
  if (!approved.includes(request.capability)) {
    throw new GeneratedBrokerError(`broker capability is not approved: ${request.capability}`)
  }
}

export function executeHostBroker(request: GeneratedBrokerRequest, approved: readonly string[]): unknown {
  assertBrokerAllowed(request, approved)
  if (request.capability === HOST_TEXT_ECHO) {
    return String(request.args.text ?? '')
  }
  throw new GeneratedBrokerError(`broker capability has no host implementation: ${request.capability}`)
}

export function approvedHostCapabilities(permissions: readonly string[]): readonly string[] {
  return permissions.filter((item) => item.startsWith('host.'))
}
