import { defineTool, type ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { CandidateManifestInput, OperationalEffects } from '../domain/candidate/index.js'
import { REMOTE_SIDE_EFFECTS } from '../domain/candidate/index.js'
import { normalizeEvaluationFixture } from '../domain/evaluation/index.js'
import { parseWorkbenchRiskModel, riskModelToolSchema, type CandidateWorkbench } from '../domain/workbench/index.js'

function textOutput() {
  return {
    schema: { type: 'string' as const },
    render(_args: unknown, value: string) {
      return [{ type: 'text' as const, text: value }]
    },
  }
}

export interface WorkbenchToolOptions {
  readonly inspectOnly?: boolean
}

/** Model-facing development tools. Cannot approve, activate, recover, or leave the candidate area. */
export function registerWorkbenchTools(
  tools: Pick<ToolRuntime, 'register'>,
  workbench: CandidateWorkbench,
  options: WorkbenchToolOptions = {},
): () => void {
  const disposeInspectContract = tools.register(defineTool({
    name: 'inspect_authoring_contract',
    description: 'Read the host-owned generated-extension-api/v1 authoring contract. Omit version or pass the full contract id; the alias "v1" is unsupported. Broker operations used by source must also be declared in manifest.permissions.',
    parameters: { version: { type: 'string' } },
    output: textOutput(),
    async execute(args) {
      return JSON.stringify(workbench.inspectAuthoringContract(
        typeof args.version === 'string' && args.version !== '' ? String(args.version) : undefined,
      ))
    },
  }))

  const disposeListWorkbench = tools.register(defineTool({
    name: 'list_workbench',
    description: 'List host-owned Capability Specifications, Resolution Plans, and Candidates after context loss. No paths or source. Pagination is bounded.',
    parameters: {
      limit: { type: 'number' },
      cursor: { type: 'string' },
    },
    output: textOutput(),
    async execute(args) {
      return JSON.stringify(workbench.list({
        limit: typeof args.limit === 'number' ? args.limit : undefined,
        cursor: typeof args.cursor === 'string' ? args.cursor : undefined,
      }))
    },
  }))

  const disposeInspectValidation = tools.register(defineTool({
    name: 'inspect_validation_diagnostics',
    description: 'Bounded per-stage validation diagnostics. Host evidence only. No absolute paths or secrets.',
    parameters: { candidateId: { type: 'string', required: true } },
    output: textOutput(),
    async execute(args) {
      return JSON.stringify(workbench.inspectValidation(String(args.candidateId)))
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

  const disposeInspectReview = tools.register(defineTool({
    name: 'inspect_candidate_review',
    description: 'Inspect Independent Review state for a candidate. Read-only.',
    parameters: { candidateId: { type: 'string', required: true } },
    output: textOutput(),
    async execute(args) {
      return JSON.stringify(workbench.inspectReview(String(args.candidateId)))
    },
  }))

  const disposeInspectSpecification = tools.register(defineTool({
    name: 'inspect_capability_specification',
    description: 'Inspect the host-owned business specification bound to a Resolution Plan or Candidate digest.',
    parameters: { specificationId: { type: 'string', required: true } },
    output: textOutput(),
    async execute(args) {
      return JSON.stringify(workbench.inspectSpecification(String(args.specificationId)))
    },
  }))

  const disposeCompareSpecifications = tools.register(defineTool({
    name: 'compare_capability_specifications',
    description: 'Compare two immutable revisions of the same Capability Specification. Read-only.',
    parameters: {
      fromSpecificationId: { type: 'string', required: true },
      toSpecificationId: { type: 'string', required: true },
    },
    output: textOutput(),
    async execute(args) {
      return JSON.stringify(workbench.compareSpecifications(
        String(args.fromSpecificationId),
        String(args.toSpecificationId),
      ))
    },
  }))

  if (options.inspectOnly) {
    return () => {
      disposeInspectContract()
      disposeListWorkbench()
      disposeInspectValidation()
      disposeInspect()
      disposeInspectReview()
      disposeInspectSpecification()
      disposeCompareSpecifications()
    }
  }


  const disposeDefineSpecification = tools.register(defineTool({
    name: 'define_capability_specification',
    description: 'Define the host-owned business intent before resolution or code. A ready specification needs at least one business rule and one concrete acceptance example. Permissions must name exact host operations.',
    parameters: {
      capability: { type: 'string', required: true },
      ...specificationPatchParameters(),
      goal: { type: 'string', required: true },
    },
    output: textOutput(),
    async execute(args, exec) {
      return JSON.stringify(workbench.defineSpecification({
        capability: String(args.capability),
        goal: String(args.goal),
        nonGoals: asStringList(args.nonGoals),
        inputs: parseSpecificationInputs(args.inputs),
        businessRules: asStringList(args.businessRules),
        permissions: asStringList(args.permissions),
        effects: parseEffects(args.effects),
        acceptanceExamples: parseAcceptanceExamples(args.acceptanceExamples),
        unresolved: asStringList(args.unresolved),
        ...(exec.agent ? { origin: { sessionId: String(exec.agent.id) } } : {}),
      }))
    },
  }))

  const disposeReviseSpecification = tools.register(defineTool({
    name: 'revise_capability_specification',
    description: 'Create a new immutable revision from an explicit Capability Specification. Omitted fields are inherited; the previous revision and its Candidate bindings remain unchanged.',
    parameters: {
      specificationId: { type: 'string', required: true },
      ...specificationPatchParameters(),
    },
    output: textOutput(),
    async execute(args) {
      return JSON.stringify(workbench.reviseSpecification(String(args.specificationId), {
        goal: optionalString(args.goal),
        nonGoals: asStringList(args.nonGoals),
        inputs: parseSpecificationInputs(args.inputs),
        businessRules: asStringList(args.businessRules),
        permissions: asStringList(args.permissions),
        effects: parseEffects(args.effects),
        acceptanceExamples: parseAcceptanceExamples(args.acceptanceExamples),
        unresolved: asStringList(args.unresolved),
      }))
    },
  }))

  const disposePlan = tools.register(defineTool({
    name: 'plan_capability_change',
    description: 'Run host-owned Capability Resolution from a ready Capability Specification. specificationId is the governed path; capability/need remain only for legacy callers.',
    parameters: {
      specificationId: { type: 'string' },
      capability: { type: 'string' },
      need: { type: 'string' },
      behavior: { type: 'string' },
    },
    output: textOutput(),
    async execute(args) {
      return JSON.stringify(workbench.plan(typeof args.specificationId === 'string' && args.specificationId !== ''
        ? { specificationId: args.specificationId }
        : {
          capability: String(args.capability),
          need: String(args.need),
          behavior: typeof args.behavior === 'string' && args.behavior !== '' ? args.behavior : undefined,
        }))
    },
  }))

  const disposeCreate = tools.register(defineTool({
    name: 'create_candidate',
    description: 'Create a candidate workspace from a host-owned plan. Owner, version, and provenance come from the plan. Declare every broker operation the source will use in permissions.',
    parameters: {
      planId: { type: 'string', required: true },
      ...manifestParameters(),
    },
    output: textOutput(),
    async execute(args) {
      return JSON.stringify(workbench.create({
        planId: String(args.planId),
        manifest: manifestFromArgs(args),
      }))
    },
  }))

  const disposeScaffold = tools.register(defineTool({
    name: 'scaffold_candidate',
    description: 'Write the host-owned R0 scaffold. Model may supply only bounded names and descriptions. Does not execute candidate code.',
    parameters: {
      candidateId: { type: 'string', required: true },
      toolName: { type: 'string' },
      toolDescription: { type: 'string' },
      capability: { type: 'string' },
    },
    output: textOutput(),
    async execute(args) {
      return JSON.stringify(workbench.scaffold({
        candidateId: String(args.candidateId),
        toolName: typeof args.toolName === 'string' ? args.toolName : undefined,
        toolDescription: typeof args.toolDescription === 'string' ? args.toolDescription : undefined,
        capability: typeof args.capability === 'string' ? args.capability : undefined,
      }))
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
    description: 'Update candidate manifest fields. Cannot change owner, provenance, or attach a shell/install runner. permissions must include every host broker operation used by candidate source.',
    parameters: {
      candidateId: { type: 'string', required: true },
      ...manifestParameters(),
    },
    output: textOutput(),
    async execute(args) {
      return JSON.stringify(workbench.setManifest(String(args.candidateId), manifestFromArgs(args)))
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
    description: 'Request Independent Review for the current sealed digest. review-complete is not a governance approval.',
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

  const disposeRepair = tools.register(defineTool({
    name: 'repair_candidate',
    description: 'Create a new mutable revision from a sealed parent with changes-required review or a rejected human approval. Parent stays immutable.',
    parameters: { candidateId: { type: 'string', required: true } },
    output: textOutput(),
    async execute(args) {
      return JSON.stringify(workbench.repair(String(args.candidateId)))
    },
  }))

  return () => {
    disposeInspectContract()
    disposeListWorkbench()
    disposeInspectValidation()
    disposeInspect()
    disposeInspectReview()
    disposeInspectSpecification()
    disposeCompareSpecifications()
    disposeDefineSpecification()
    disposeReviseSpecification()
    disposePlan()
    disposeCreate()
    disposeScaffold()
    disposeList()
    disposeRead()
    disposeWrite()
    disposeManifest()
    disposeValidate()
    disposeSeal()
    disposeReview()
    disposeRepair()
  }
}

function specificationPatchParameters() {
  const strings = { type: 'array' as const, items: { type: 'string' as const } }
  return {
    goal: { type: 'string' as const },
    nonGoals: strings,
    inputs: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          name: { type: 'string' as const },
          description: { type: 'string' as const },
          required: { type: 'boolean' as const },
        },
      },
    },
    businessRules: strings,
    permissions: strings,
    effects: manifestParameters().effects,
    acceptanceExamples: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          name: { type: 'string' as const },
          given: strings,
          when: { type: 'string' as const },
          then: strings,
          fixture: {
            type: 'object' as const,
            additionalProperties: false,
            properties: {
              input: { type: 'object' as const, additionalProperties: true },
              expected: { type: 'json' as const },
            },
          },
        },
      },
    },
    unresolved: strings,
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function parseSpecificationInputs(value: unknown) {
  if (!Array.isArray(value)) return undefined
  return value.map((item) => {
    const input = item as Record<string, unknown>
    return {
      name: typeof input.name === 'string' ? input.name : '',
      description: typeof input.description === 'string' ? input.description : '',
      required: input.required === true,
    }
  })
}

function parseAcceptanceExamples(value: unknown) {
  if (!Array.isArray(value)) return undefined
  return value.map((item) => {
    const example = item as Record<string, unknown>
    return {
      name: typeof example.name === 'string' ? example.name : '',
      given: asStringList(example.given) ?? [],
      when: typeof example.when === 'string' ? example.when : '',
      then: asStringList(example.then) ?? [],
      ...(example.fixture === undefined ? {} : { fixture: normalizeEvaluationFixture(example.fixture, 'acceptanceExample') }),
    }
  })
}

function manifestParameters() {
  const strings = { type: 'array' as const, items: { type: 'string' as const } }
  return {
    capabilities: strings,
    permissions: {
      ...strings,
      description: 'Exact host broker operations requested by candidate source, for example host.text.echo or host.knowledge.retrieve. These are bound into review and human approval.',
    },
    runtimeSeams: strings,
    tools: strings,
    services: strings,
    providers: strings,
    workflows: {
      type: 'array' as const,
      description: 'Governed DSH WorkflowMeta declarations. script is a candidate-relative orchestration body; models can run it only after activation by registered name.',
      items: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          name: { type: 'string' as const },
          description: { type: 'string' as const },
          whenToUse: { type: 'string' as const },
          script: { type: 'string' as const },
          intent: { type: 'string' as const },
          maxInputBytes: { type: 'number' as const },
          maxTotalAgents: { type: 'number' as const },
          phases: { type: 'array' as const, items: { type: 'object' as const, additionalProperties: true } },
          inputFields: { type: 'array' as const, items: { type: 'object' as const, additionalProperties: true } },
        },
      },
    },
    secrets: strings,
    configRequired: strings,
    entryPoints: strings,
    effects: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        filesystem: strings,
        network: strings,
        process: strings,
        secrets: strings,
        externalSystems: strings,
        remoteSideEffect: { type: 'string' as const },
      },
    },
    riskModel: riskModelToolSchema(),
    pluginDependencies: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          capability: { type: 'string' as const },
          strength: { type: 'string' as const },
        },
      },
    },
  }
}

function manifestFromArgs(args: Record<string, unknown>): CandidateManifestInput {
  return {
    capabilities: asStringList(args.capabilities),
    permissions: asStringList(args.permissions),
    runtimeSeams: asStringList(args.runtimeSeams),
    tools: asStringList(args.tools),
    services: asStringList(args.services),
    providers: asStringList(args.providers),
    workflows: parseWorkflows(args.workflows),
    secrets: asStringList(args.secrets),
    configRequired: asStringList(args.configRequired),
    effects: parseEffects(args.effects),
    entryPoints: asStringList(args.entryPoints),
    riskModel: parseRiskModel(args.riskModel),
    pluginDependencies: parsePluginDependencies(args.pluginDependencies),
  }
}

function parseWorkflows(value: unknown): CandidateManifestInput['workflows'] {
  if (!Array.isArray(value)) return undefined
  return value.map((item) => {
    const row = item as Record<string, unknown>
    return {
      name: typeof row.name === 'string' ? row.name : '',
      description: typeof row.description === 'string' ? row.description : '',
      ...(typeof row.whenToUse === 'string' ? { whenToUse: row.whenToUse } : {}),
      script: typeof row.script === 'string' ? row.script : '',
      intent: row.intent as 'read' | 'mutate',
      maxInputBytes: Number(row.maxInputBytes),
      maxTotalAgents: Number(row.maxTotalAgents),
      ...(Array.isArray(row.phases) ? { phases: row.phases.map((phase) => {
        const value = phase as Record<string, unknown>
        return { title: String(value.title ?? ''), ...(typeof value.detail === 'string' ? { detail: value.detail } : {}) }
      }) } : {}),
      ...(Array.isArray(row.inputFields) ? { inputFields: row.inputFields.map((field) => {
        const value = field as Record<string, unknown>
        return { name: String(value.name ?? ''), required: value.required === true, ...(typeof value.description === 'string' ? { description: value.description } : {}) }
      }) } : {}),
    }
  })
}

function parsePluginDependencies(value: unknown): CandidateManifestInput['pluginDependencies'] {
  if (!Array.isArray(value)) return undefined
  return value.map((item) => {
    const rec = item as { capability?: unknown; strength?: unknown }
    return {
      capability: typeof rec.capability === 'string' ? rec.capability : '',
      strength: rec.strength as 'hard' | 'optional',
    }
  })
}

function parseEffects(value: unknown): Partial<OperationalEffects> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const remote = input.remoteSideEffect
  return {
    filesystem: asStringList(input.filesystem),
    network: asStringList(input.network),
    process: asStringList(input.process),
    secrets: asStringList(input.secrets),
    externalSystems: asStringList(input.externalSystems),
    remoteSideEffect: typeof remote === 'string' && (REMOTE_SIDE_EFFECTS as readonly string[]).includes(remote)
      ? remote as OperationalEffects['remoteSideEffect']
      : undefined,
  }
}

function parseRiskModel(value: unknown) {
  if (value === undefined || value === null) return undefined
  return parseWorkbenchRiskModel(value)
}

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map((item) => String(item))
}
