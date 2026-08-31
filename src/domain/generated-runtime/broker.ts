import type { GeneratedBrokerExecution, GeneratedBrokerRequest } from './types.js'

export const HOST_TEXT_ECHO = 'host.text.echo'
export const HOST_KNOWLEDGE_RETRIEVE = 'host.knowledge.retrieve'
export const GENERATED_BROKER_OPS = [HOST_TEXT_ECHO, HOST_KNOWLEDGE_RETRIEVE] as const

const MAX_BROKER_ARGUMENT_BYTES = 16 * 1024
const MAX_BROKER_RESULT_BYTES = 48 * 1024

export interface GeneratedBrokerOperation {
  readonly capability: typeof GENERATED_BROKER_OPS[number]
  execute(args: Readonly<Record<string, unknown>>, execution: GeneratedBrokerExecution): Promise<unknown> | unknown
}

export class GeneratedBrokerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GeneratedBrokerError'
  }
}

export function assertGeneratedBrokerPermissions(permissions: readonly string[]): void {
  const unsupported = permissions.find((permission) => !(GENERATED_BROKER_OPS as readonly string[]).includes(permission))
  if (unsupported !== undefined) {
    throw new GeneratedBrokerError(`unsupported generated Broker permission: ${unsupported}`)
  }
}

/** Unknown operations and permissions absent from the sealed approval fail closed. */
export function assertBrokerAllowed(request: GeneratedBrokerRequest, approved: readonly string[]): void {
  if (!approved.includes(request.capability)) {
    throw new GeneratedBrokerError(`broker capability is not approved: ${request.capability}`)
  }
}

function boundedJson(value: unknown, maxBytes: number, label: string): unknown {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new GeneratedBrokerError(`${label} is not JSON-serializable`)
  }
  if (serialized === undefined) throw new GeneratedBrokerError(`${label} is not JSON-serializable`)
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new GeneratedBrokerError(`${label} exceeds the ${maxBytes}-byte limit`)
  }
  return JSON.parse(serialized) as unknown
}

/**
 * Host-owned broker module. Callers learn one request interface; operation
 * lookup, exact approval, cancellation, input/output bounds, and JSON
 * detachment stay local to this implementation.
 */
export class GeneratedHostBroker {
  private readonly operations = new Map<string, GeneratedBrokerOperation>()

  constructor(operations: readonly GeneratedBrokerOperation[]) {
    for (const operation of operations) {
      if (this.operations.has(operation.capability)) {
        throw new GeneratedBrokerError(`duplicate generated Broker operation: ${operation.capability}`)
      }
      this.operations.set(operation.capability, operation)
    }
  }

  async request(
    request: GeneratedBrokerRequest,
    approved: readonly string[],
    execution: GeneratedBrokerExecution,
  ): Promise<unknown> {
    execution.signal.throwIfAborted()
    assertBrokerAllowed(request, approved)
    const operation = this.operations.get(request.capability)
    if (!operation) throw new GeneratedBrokerError(`broker capability has no host implementation: ${request.capability}`)
    const args = boundedJson(request.args, MAX_BROKER_ARGUMENT_BYTES, 'broker arguments') as Record<string, unknown>
    const value = await operation.execute(Object.freeze(args), execution)
    execution.signal.throwIfAborted()
    return boundedJson(value, MAX_BROKER_RESULT_BYTES, 'broker result')
  }
}

export const textEchoBrokerOperation: GeneratedBrokerOperation = {
  capability: HOST_TEXT_ECHO,
  execute(args) {
    return String(args.text ?? '')
  },
}

/** Compatibility helper for the core, context-free operation set. */
export function executeHostBroker(
  request: GeneratedBrokerRequest,
  approved: readonly string[],
  execution: GeneratedBrokerExecution = { signal: new AbortController().signal },
): Promise<unknown> {
  return new GeneratedHostBroker([textEchoBrokerOperation]).request(request, approved, execution)
}

export function approvedHostCapabilities(permissions: readonly string[]): readonly string[] {
  return permissions.filter((item) => item.startsWith('host.'))
}
