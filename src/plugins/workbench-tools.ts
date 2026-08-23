import { defineTool, type ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { CandidateWorkbench } from '../domain/workbench/index.js'

function textOutput() {
  return {
    schema: { type: 'string' as const },
    render(_args: unknown, value: string) {
      return [{ type: 'text' as const, text: value }]
    },
  }
}

/** Model-facing development tools. Cannot approve, activate, recover, or leave the candidate area. */
export function registerWorkbenchTools(
  tools: Pick<ToolRuntime, 'register'>,
  workbench: CandidateWorkbench,
): () => void {
  const disposePlan = tools.register(defineTool({
    name: 'plan_capability_change',
    description: 'Host-owned Capability Resolution for a requested change. Stores a plan id. Does not create or approve a plugin.',
    parameters: {
      capability: { type: 'string', required: true },
      need: { type: 'string', required: true },
      behavior: { type: 'string' },
    },
    output: textOutput(),
    async execute(args) {
      return JSON.stringify(workbench.plan({
        capability: String(args.capability),
        need: String(args.need),
        behavior: typeof args.behavior === 'string' && args.behavior !== '' ? args.behavior : undefined,
      }))
    },
  }))

  const disposeCreate = tools.register(defineTool({
    name: 'create_candidate',
    description: 'Create a candidate workspace from a host-owned plan. Owner, version, and provenance come from the plan.',
    parameters: {
      planId: { type: 'string', required: true },
      capabilities: { type: 'array', items: { type: 'string' } },
      tools: { type: 'array', items: { type: 'string' } },
      entryPoints: { type: 'array', items: { type: 'string' } },
    },
    output: textOutput(),
    async execute(args) {
      return JSON.stringify(workbench.create({
        planId: String(args.planId),
        manifest: {
          capabilities: asStringList(args.capabilities),
          tools: asStringList(args.tools),
          entryPoints: asStringList(args.entryPoints),
        },
      }))
    },
  }))

  const disposeInspect = tools.register(defineTool({
    name: 'inspect_candidate',
    description: 'Inspect host-owned candidate status, validation, review, and approval-request eligibility. Read-only.',
    parameters: { candidateId: { type: 'string', required: true } },
    output: textOutput(),
    async execute(args) {
      return JSON.stringify(workbench.inspect(String(args.candidateId)))
    },
  }))

  const disposeList = tools.register(defineTool({
    name: 'list_candidate_files',
    description: 'List files inside one managed candidate workspace. Rejects operator-sandbox roots and host paths.',
    parameters: { candidateId: { type: 'string', required: true } },
    output: textOutput(),
    async execute(args) {
      return JSON.stringify({ files: workbench.listFiles(String(args.candidateId)) })
    },
  }))

  const disposeRead = tools.register(defineTool({
    name: 'read_candidate_file',
    description: 'Read one file inside a managed candidate workspace. Candidate-relative paths only.',
    parameters: {
      candidateId: { type: 'string', required: true },
      path: { type: 'string', required: true },
    },
    output: textOutput(),
    async execute(args) {
      return workbench.readFile(String(args.candidateId), String(args.path))
    },
  }))

  const disposeWrite = tools.register(defineTool({
    name: 'write_candidate_file',
    description: 'Write one file inside a managed candidate workspace. Not install authority. Sealed candidates reject writes.',
    parameters: {
      candidateId: { type: 'string', required: true },
      path: { type: 'string', required: true },
      content: { type: 'string', required: true },
    },
    output: textOutput(),
    async execute(args) {
      return JSON.stringify(workbench.writeFile(String(args.candidateId), String(args.path), String(args.content)))
    },
  }))

  const disposeManifest = tools.register(defineTool({
    name: 'set_candidate_manifest',
    description: 'Update candidate manifest fields. Cannot change owner, provenance, or attach a shell/install runner.',
    parameters: {
      candidateId: { type: 'string', required: true },
      capabilities: { type: 'array', items: { type: 'string' } },
      permissions: { type: 'array', items: { type: 'string' } },
      tools: { type: 'array', items: { type: 'string' } },
      entryPoints: { type: 'array', items: { type: 'string' } },
    },
    output: textOutput(),
    async execute(args) {
      return JSON.stringify(workbench.setManifest(String(args.candidateId), {
        capabilities: asStringList(args.capabilities),
        permissions: asStringList(args.permissions),
        tools: asStringList(args.tools),
        entryPoints: asStringList(args.entryPoints),
      }))
    },
  }))

  const disposeValidate = tools.register(defineTool({
    name: 'validate_candidate',
    description: 'Run bounded deterministic validation. Does not import candidate code into the host or approve it.',
    parameters: { candidateId: { type: 'string', required: true } },
    output: textOutput(),
    async execute(args) {
      return JSON.stringify(workbench.validate(String(args.candidateId)))
    },
  }))

  const disposeSeal = tools.register(defineTool({
    name: 'seal_candidate',
    description: 'Seal the current candidate digest. Further writes require a new repair revision.',
    parameters: { candidateId: { type: 'string', required: true } },
    output: textOutput(),
    async execute(args) {
      return JSON.stringify(workbench.seal(String(args.candidateId)))
    },
  }))

  const disposeReview = tools.register(defineTool({
    name: 'review_candidate',
    description: 'Request Independent Review for the current sealed digest. review-complete is NOT APPROVED.',
    parameters: { candidateId: { type: 'string', required: true } },
    output: textOutput(),
    async execute(args) {
      const report = workbench.review(String(args.candidateId))
      return JSON.stringify({
        candidateId: report.candidateId,
        digest: report.digest,
        state: report.state,
        approvalStatus: report.approvalStatus,
        blockingFindings: report.findings.filter((item) => item.blocking && item.status === 'open').length,
        findings: report.findings.map((item) => ({
          id: item.id,
          severity: item.severity,
          claim: item.claim,
          blocking: item.blocking,
          status: item.status,
        })),
      })
    },
  }))

  const disposeInspectReview = tools.register(defineTool({
    name: 'inspect_candidate_review',
    description: 'Inspect Independent Review state for a candidate. Read-only.',
    parameters: { candidateId: { type: 'string', required: true } },
    output: textOutput(),
    async execute(args) {
      return JSON.stringify(workbench.inspectReview(String(args.candidateId)))
    },
  }))

  const disposeRepair = tools.register(defineTool({
    name: 'repair_candidate',
    description: 'Create a new mutable revision from a sealed parent with changes-required review. Parent stays immutable.',
    parameters: { candidateId: { type: 'string', required: true } },
    output: textOutput(),
    async execute(args) {
      return JSON.stringify(workbench.repair(String(args.candidateId)))
    },
  }))

  return () => {
    disposePlan()
    disposeCreate()
    disposeInspect()
    disposeList()
    disposeRead()
    disposeWrite()
    disposeManifest()
    disposeValidate()
    disposeSeal()
    disposeReview()
    disposeInspectReview()
    disposeRepair()
  }
}

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map((item) => String(item))
}
