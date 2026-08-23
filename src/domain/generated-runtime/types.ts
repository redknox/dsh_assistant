export const GENERATED_STARTUP_TIMEOUT_MS = 8_000
export const GENERATED_CALL_TIMEOUT_MS = 5_000
export const GENERATED_MAX_MESSAGE_BYTES = 64 * 1024
export const GENERATED_MAX_STDERR_BYTES = 8 * 1024

export type GeneratedIsolation = 'sandbox-exec' | 'unshare' | 'unavailable'

export interface GeneratedRuntimeDiagnosis {
  readonly state: 'available' | 'unavailable'
  readonly isolation: GeneratedIsolation
  readonly activeProcesses: number
  readonly lastFailure?: string
}

export interface GeneratedBrokerRequest {
  readonly capability: string
  readonly args: Record<string, unknown>
}

export interface GeneratedToolDescriptor {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: Record<string, unknown>
}

export interface GeneratedPrepareInput {
  readonly candidateId: string
  readonly workspaceRoot: string
  readonly entryPoints: readonly string[]
  readonly owner: string
  readonly digest?: string
  readonly tools: readonly string[]
  readonly permissions: readonly string[]
}
