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
    readonly brokerPermissions: 'every broker operation used by candidate source must be declared in manifest.permissions and approved with the exact diff'
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
  readonly workflow: {
    readonly scriptFormat: 'JavaScript async-function body'
    readonly scriptExtensions: readonly ['.js', '.mjs', '.cjs']
    readonly parameters: readonly ['args', 'agent', 'parallel', 'pipeline', 'phase', 'log']
    readonly manifestShape: 'workflows[].phases use { title, detail? }; inputFields use { name, required, description? }'
    readonly executionBoundary: 'registered catalog name plus JSON input only; callers never provide script text'
    readonly runtimeGlobals: 'ECMAScript intrinsics only; no Node, Web, timer, URL, TextEncoder, or fetch globals; maxInputBytes is host-enforced'
    readonly example: string
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
      brokerPermissions: 'every broker operation used by candidate source must be declared in manifest.permissions and approved with the exact diff',
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
    workflow: {
      scriptFormat: 'JavaScript async-function body',
      scriptExtensions: ['.js', '.mjs', '.cjs'],
      parameters: ['args', 'agent', 'parallel', 'pipeline', 'phase', 'log'],
      manifestShape: 'workflows[].phases use { title, detail? }; inputFields use { name, required, description? }',
      executionBoundary: 'registered catalog name plus JSON input only; callers never provide script text',
      runtimeGlobals: 'ECMAScript intrinsics only; no Node, Web, timer, URL, TextEncoder, or fetch globals; maxInputBytes is host-enforced',
      example: `phase('Analyze')
const [risk, opportunity] = await parallel([
  () => agent('Analyze risk for: ' + args.subject, { label: 'risk', phase: 'Analyze' }),
  () => agent('Analyze opportunity for: ' + args.subject, { label: 'opportunity', phase: 'Analyze' }),
])
phase('Synthesize')
const synthesis = await agent('Synthesize: ' + JSON.stringify({ risk, opportunity }), { label: 'synthesis', phase: 'Synthesize' })
return { risk, opportunity, synthesis }`,
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
