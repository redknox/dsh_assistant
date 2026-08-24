import { defineTool, type ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { ExtensionGovernance } from '../domain/governance/index.js'

function textOutput() {
  return {
    schema: { type: 'string' as const },
    render(_args: unknown, value: string) {
      return [{ type: 'text' as const, text: value }]
    },
  }
}

/** Read/request only. Cannot approve, activate, uninstall, rollback, or rewrite recovery. */
export function registerGovernanceTools(
  tools: Pick<ToolRuntime, 'register'>,
  governance: ExtensionGovernance,
  options: { readonly allowRequest?: boolean } = {},
): () => void {
  const disposeInspect = tools.register(defineTool({
    name: 'inspect_extension_governance',
    description: 'Inspect a candidate approval summary and eligibility. Read-only; does not approve or activate.',
    parameters: {
      candidateId: { type: 'string', required: true },
    },
    output: textOutput(),
    async execute(args) {
      const candidateId = String(args.candidateId)
      return JSON.stringify({
        summary: governance.inspectSummary(candidateId),
        approval: governance.inspectApproval(candidateId),
        eligibility: governance.eligibility(candidateId),
        requestEligibility: governance.requestEligibility(candidateId),
      })
    },
  }))

  const disposeRequest = options.allowRequest === false
    ? undefined
    : tools.register(defineTool({
      name: 'request_extension_approval',
      description: 'Request human approval for a sealed, validated, independently reviewed candidate. Does not approve or activate.',
      parameters: {
        candidateId: { type: 'string', required: true },
      },
      output: textOutput(),
      async execute(args) {
        return JSON.stringify(governance.requestApproval(String(args.candidateId)))
      },
    }))

  return () => {
    disposeInspect()
    disposeRequest?.()
  }
}
