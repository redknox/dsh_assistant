import { defineTool, type ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { CapabilityRegistry } from '../domain/registry/index.js'

function textOutput() {
  return {
    schema: { type: 'string' as const },
    render(_args: unknown, value: string) {
      return [{ type: 'text' as const, text: value }]
    },
  }
}

/** Read-only adapters. No register, approve, install, or status mutation. */
export function registerRegistryTools(tools: Pick<ToolRuntime, 'register'>, registry: CapabilityRegistry): () => void {
  const disposeList = tools.register(defineTool({
    name: 'list_capabilities',
    description: 'List Capability Registry records (What do I have?). Read-only; does not install or approve plugins.',
    parameters: {
      owner: { type: 'string' },
      status: { type: 'string', enum: ['candidate', 'active', 'disabled', 'retired'] },
      capability: { type: 'string' },
    },
    output: textOutput(),
    async execute(args) {
      const records = registry.list({
        owner: typeof args.owner === 'string' && args.owner !== '' ? args.owner : undefined,
        status: args.status === 'candidate' || args.status === 'active' || args.status === 'disabled' || args.status === 'retired'
          ? args.status
          : undefined,
        capability: typeof args.capability === 'string' && args.capability !== '' ? args.capability : undefined,
      })
      return JSON.stringify(records.map((record) => ({
        owner: record.owner,
        version: record.version,
        status: record.status,
        approval: record.approval,
        evidence: record.evidence,
        capabilities: record.capabilities.map((item) => item.id),
      })))
    },
  }))

  const disposeLookup = tools.register(defineTool({
    name: 'lookup_capability',
    description: 'Resolve the current active owner for one capability. Read-only; unknown is not false.',
    parameters: {
      capability: { type: 'string', required: true },
    },
    output: textOutput(),
    async execute(args) {
      return JSON.stringify(registry.resolveActiveOwner(String(args.capability)))
    },
  }))

  return () => {
    disposeList()
    disposeLookup()
  }
}
