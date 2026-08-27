import { GENERATED_BROKER_OPS } from '../generated-runtime/broker.js'

export const GENERATED_EXTENSION_API_V1 = 'generated-extension-api/v1'
export const AUTHORING_CONTRACT_STAMP = 'generated-extension-api.json'

const SUPPORTED = new Set([GENERATED_EXTENSION_API_V1])

export interface AuthoringContractV1 {
  readonly id: typeof GENERATED_EXTENSION_API_V1
  readonly hostOwned: true
  readonly candidateCannotRedefine: true
  readonly entry: {
    readonly module: 'src/plugin.js'
    readonly export: 'apply'
    readonly signature: 'apply(ctx)'
  }
  readonly allowedCtx: readonly string[]
  readonly ctxSemantics: {
    readonly effect: 'cleanup registration only: effect(setup: () => (() => void) | void): () => void'
    readonly brokerRequest: 'request(capability: brokerOps[number], args: object): Promise<unknown>'
  }
  readonly brokerOps: readonly string[]
  readonly forbiddenHostApis: readonly string[]
  readonly packageRules: {
    readonly type: 'module'
    readonly scripts: 'forbidden'
    readonly dependencies: 'forbidden'
    readonly lifecycleScripts: 'forbidden'
  }
  readonly validation: {
    readonly hostOwned: true
    readonly nodeNativeTests: true
    readonly noCandidateArgv: true
  }
  readonly sizeBounds: {
    readonly maxFileBytes: number
    readonly maxWorkspaceBytes: number
    readonly maxFileCount: number
  }
  readonly lifecycle: readonly string[]
}

/** Host-owned generated-extension-api/v1. Candidates may consume this; they cannot redefine it. */
export function authoringContractV1(): AuthoringContractV1 {
  return {
    id: GENERATED_EXTENSION_API_V1,
    hostOwned: true,
    candidateCannotRedefine: true,
    entry: {
      module: 'src/plugin.js',
      export: 'apply',
      signature: 'apply(ctx)',
    },
    allowedCtx: [
      'ctx.tools.register',
      'ctx.tools.get',
      'ctx.effect',
      'ctx.broker.request',
    ],
    ctxSemantics: {
      effect: 'cleanup registration only: effect(setup: () => (() => void) | void): () => void',
      brokerRequest: 'request(capability: brokerOps[number], args: object): Promise<unknown>',
    },
    brokerOps: [...GENERATED_BROKER_OPS],
    forbiddenHostApis: [
      'ctx.get',
      'ctx.plugin',
      'live Cordis context',
      'process',
      'child_process',
      'fs',
      'net',
      'http',
      'https',
      'worker_threads',
      'host secrets',
      'operator sandbox',
    ],
    packageRules: {
      type: 'module',
      scripts: 'forbidden',
      dependencies: 'forbidden',
      lifecycleScripts: 'forbidden',
    },
    validation: {
      hostOwned: true,
      nodeNativeTests: true,
      noCandidateArgv: true,
    },
    sizeBounds: {
      maxFileBytes: 256 * 1024,
      maxWorkspaceBytes: 2 * 1024 * 1024,
      maxFileCount: 80,
    },
    lifecycle: [
      'scaffold',
      'edit',
      'validate',
      'seal',
      'independent-review',
      'approval-request',
      'human-approve',
      'human-activate',
      'isolated-run',
    ],
  }
}

export function assertSupportedAuthoringContract(version?: string): typeof GENERATED_EXTENSION_API_V1 {
  const id = version ?? GENERATED_EXTENSION_API_V1
  if (!SUPPORTED.has(id)) {
    throw new Error(`unsupported authoring contract: ${id}`)
  }
  return GENERATED_EXTENSION_API_V1
}
