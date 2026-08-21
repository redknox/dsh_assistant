import { defineTool, type ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { CapabilityResolution } from '../domain/resolution/index.js'
import { CORE_KNOWN_SEAMS } from '../domain/resolution/index.js'

function textOutput() {
  return {
    schema: { type: 'string' as const },
    render(_args: unknown, value: string) {
      return [{ type: 'text' as const, text: value }]
    },
  }
}

/** Advisory-only adapter. Does not register, approve, install, or mutate registry/runtime. */
export function registerResolutionTools(
  tools: Pick<ToolRuntime, 'register'>,
  resolution: CapabilityResolution,
): () => void {
  return tools.register(defineTool({
    name: 'review_capability_resolution',
    description: 'Advise what should change for a capability need. Read-only; does not install or approve plugins.',
    parameters: {
      capability: { type: 'string', required: true },
      need: { type: 'string', required: true },
      behavior: { type: 'string' },
      inventoryComplete: { type: 'boolean' },
    },
    output: textOutput(),
    async execute(args) {
      const review = resolution.review({
        capability: String(args.capability),
        need: String(args.need),
        behavior: typeof args.behavior === 'string' && args.behavior !== '' ? args.behavior : undefined,
        inventory: args.inventoryComplete === true
          ? { complete: true, seams: CORE_KNOWN_SEAMS }
          : undefined,
      })
      return JSON.stringify({
        kind: review.kind,
        recommendation: review.recommendation,
        rationale: review.rationale,
        target: review.target,
        steps: review.steps,
        unresolved: review.unresolved,
      })
    },
  }))
}
