import { AUTHORING_CONTRACT_STAMP, GENERATED_EXTENSION_API_V1 } from './authoring-contract.js'
import { WorkbenchContractError } from './errors.js'

export interface ScaffoldNames {
  readonly owner: string
  readonly capability: string
  readonly toolName: string
  readonly toolDescription: string
}

const TOOL_NAME = /^[a-z][a-z0-9_]{1,47}$/
const IDENT = /^[A-Za-z][A-Za-z0-9._-]{1,63}$/

export function parseScaffoldNames(input: {
  readonly owner: string
  readonly capability: string
  readonly toolName?: string
  readonly toolDescription?: string
  readonly capabilityOverride?: string
}): ScaffoldNames {
  if (input.capabilityOverride !== undefined && input.capabilityOverride !== input.capability) {
    throw new WorkbenchContractError('scaffold capability must match the host plan')
  }
  const toolName = input.toolName ?? defaultToolName(input.capability)
  if (!TOOL_NAME.test(toolName)) throw new WorkbenchContractError('scaffold tool name is not a bounded identifier')
  if (input.toolDescription !== undefined && input.toolDescription.length > 200) {
    throw new WorkbenchContractError('scaffold description exceeds the 200 character bound')
  }
  if (!IDENT.test(input.capability)) throw new WorkbenchContractError('scaffold capability is invalid')
  return {
    owner: input.owner,
    capability: input.capability,
    toolName,
    toolDescription: input.toolDescription ?? `${input.capability} generated tool (not implemented)`,
  }
}

export function scaffoldFiles(names: ScaffoldNames): Record<string, string> {
  const pkgName = names.owner.replaceAll('/', '-')
  return {
    'package.json': `${JSON.stringify({
      name: pkgName,
      type: 'module',
      main: 'src/plugin.js',
    }, null, 2)}\n`,
    'src/plugin.js': pluginStub(names),
    'src/plugin.test.js': pluginTest(names),
    [AUTHORING_CONTRACT_STAMP]: `${JSON.stringify({
      version: GENERATED_EXTENSION_API_V1,
      hostOwned: true,
    }, null, 2)}\n`,
  }
}

export function defaultToolName(capability: string): string {
  return capability.replaceAll('.', '_').replaceAll('-', '_')
}

function pluginStub(names: ScaffoldNames): string {
  return `export const name = ${JSON.stringify(names.owner)}

export function slugify(text) {
  throw new Error('not implemented')
}

export function apply(ctx) {
  const dispose = ctx.tools.register({
    name: ${JSON.stringify(names.toolName)},
    description: ${JSON.stringify(names.toolDescription)},
    parameters: { text: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render(_args, value) { return [{ type: 'text', text: String(value) }] } },
    async execute(args) {
      return slugify(String(args.text ?? ''))
    },
  })
  ctx.effect(() => dispose)
}
`
}

function pluginTest(names: ScaffoldNames): string {
  return `import assert from 'node:assert/strict'
import { test } from 'node:test'
import { slugify } from './plugin.js'

test(${JSON.stringify(`${names.toolName} slugifies text`)}, () => {
  assert.equal(slugify('Hello World'), 'hello-world')
})
`
}
