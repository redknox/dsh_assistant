import type { Agent } from '@deepseek-ai/dsh-agent'
import type { WorkflowEngine, WorkflowMeta } from '@deepseek-ai/dsh-workflow'

export type WorkflowProvenance = 'managed' | 'generated' | 'third-party'
export type WorkflowGovernance = 'host-managed' | 'generated-governed' | 'third-party-governed'

export interface WorkflowCatalogEntry {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly whenToUse?: string
  readonly owner: string
  readonly version: string
  readonly provenance: WorkflowProvenance
  readonly governance: WorkflowGovernance
  readonly engine: 'dsh-workflow'
  readonly runtime: 'isolated-process'
  readonly lifecycle: 'active'
  readonly intent: 'read' | 'mutate'
  readonly phases: readonly { readonly title: string; readonly detail?: string }[]
  readonly inputFields: readonly { readonly name: string; readonly required: boolean; readonly description?: string }[]
  readonly maxTotalAgents: number
}

export interface WorkflowCatalogView {
  readonly summary: {
    readonly total: number
    readonly hostManaged: number
    readonly generatedGoverned: number
    readonly thirdPartyGoverned: number
  }
  readonly workflows: readonly WorkflowCatalogEntry[]
}

export interface GovernedWorkflowDefinition<Input = unknown> {
  readonly meta: WorkflowMeta
  readonly title: string
  readonly script: string
  readonly owner: string
  readonly version: string
  readonly provenance: WorkflowProvenance
  readonly intent: 'read' | 'mutate'
  readonly inputFields: readonly { readonly name: string; readonly required: boolean; readonly description?: string }[]
  readonly maxInputBytes: number
  readonly maxTotalAgents: number
  readonly parseInput: (value: unknown) => Input
}

export interface WorkflowExecutionResult {
  readonly runId: string
  readonly agentsStarted: number
  readonly result: unknown
}

export interface WorkflowExecutionContext {
  readonly parent: Agent
  readonly signal?: AbortSignal
}

interface StoredWorkflow {
  readonly entry: WorkflowCatalogEntry
  readonly script: string
  readonly maxInputBytes: number
  readonly parseInput: (value: unknown) => unknown
  readonly meta: WorkflowMeta
}

/**
 * Trusted catalog for native DSH workflows. Callers can list active metadata or
 * execute an exact registered name; script text never crosses this interface.
 */
export class GovernedWorkflowCatalog {
  private readonly workflows = new Map<string, StoredWorkflow>()

  constructor(
    private readonly engine: WorkflowEngine,
    private readonly subagentProvider: string,
    private readonly deploymentAgentCap: number,
  ) {}

  register<Input>(definition: GovernedWorkflowDefinition<Input>): () => void {
    const name = workflowName(definition.meta.name)
    if (this.workflows.has(name)) throw new Error(`workflow already registered: ${name}`)
    if (definition.script.trim() === '') throw new Error(`workflow ${name} has an empty script`)
    if (utf8Bytes(definition.script) > 64 * 1024) throw new Error(`workflow ${name} script exceeds the 65536-byte limit`)
    if (!Number.isSafeInteger(definition.maxInputBytes) || definition.maxInputBytes < 2) {
      throw new Error(`workflow ${name} has an invalid input limit`)
    }
    if (!Number.isSafeInteger(definition.maxTotalAgents)
      || definition.maxTotalAgents < 1
      || definition.maxTotalAgents > this.deploymentAgentCap) {
      throw new Error(`workflow ${name} has an invalid agent limit`)
    }
    const provenance = definition.provenance
    const governance: WorkflowGovernance = provenance === 'generated'
      ? 'generated-governed'
      : provenance === 'third-party'
        ? 'third-party-governed'
        : 'host-managed'
    const entry: WorkflowCatalogEntry = Object.freeze({
      name,
      title: bounded(definition.title, 120),
      description: bounded(definition.meta.description, 400),
      ...(definition.meta.whenToUse ? { whenToUse: bounded(definition.meta.whenToUse, 400) } : {}),
      owner: bounded(definition.owner, 160),
      version: bounded(definition.version, 32),
      provenance,
      governance,
      engine: 'dsh-workflow',
      runtime: 'isolated-process',
      lifecycle: 'active',
      intent: definition.intent,
      phases: (definition.meta.phases ?? []).slice(0, 32).map((phase) => Object.freeze({
        title: bounded(phase.title, 120),
        ...(phase.detail ? { detail: bounded(phase.detail, 300) } : {}),
      })),
      inputFields: definition.inputFields.slice(0, 64).map((field) => Object.freeze({
        name: bounded(field.name, 120),
        required: field.required,
        ...(field.description ? { description: bounded(field.description, 300) } : {}),
      })),
      maxTotalAgents: definition.maxTotalAgents,
    })
    this.workflows.set(name, {
      entry,
      script: definition.script,
      maxInputBytes: definition.maxInputBytes,
      parseInput: definition.parseInput as (value: unknown) => unknown,
      meta: definition.meta,
    })
    return () => {
      const current = this.workflows.get(name)
      if (current?.entry.owner === definition.owner && current.entry.version === definition.version) this.workflows.delete(name)
    }
  }

  list(): WorkflowCatalogView {
    const workflows = [...this.workflows.values()].map((item) => item.entry)
      .sort((left, right) => left.name.localeCompare(right.name))
    return {
      summary: {
        total: workflows.length,
        hostManaged: workflows.filter((item) => item.governance === 'host-managed').length,
        generatedGoverned: workflows.filter((item) => item.governance === 'generated-governed').length,
        thirdPartyGoverned: workflows.filter((item) => item.governance === 'third-party-governed').length,
      },
      workflows,
    }
  }

  async execute(name: string, input: unknown, context: WorkflowExecutionContext): Promise<WorkflowExecutionResult> {
    const workflow = this.workflows.get(workflowName(name))
    if (!workflow) throw new Error(`unknown registered workflow: ${name}`)
    let serialized: string
    try {
      serialized = JSON.stringify(input)
    } catch {
      throw new Error(`workflow ${name} input must be JSON-serializable`)
    }
    if (utf8Bytes(serialized) > workflow.maxInputBytes) {
      throw new Error(`registered workflow input exceeds the ${workflow.maxInputBytes}-byte limit`)
    }
    const args = workflow.parseInput(input)
    const run = this.engine.start({
      meta: workflow.meta,
      script: workflow.script,
      args,
      parent: context.parent,
      ...(context.signal ? { signal: context.signal } : {}),
      subagentProvider: this.subagentProvider,
      maxTotalAgents: workflow.entry.maxTotalAgents,
    })
    try {
      const result = await run.result
      if (result.stopReason !== 'completed') {
        throw new Error(`workflow ${result.stopReason}: ${result.error ?? 'no detail'}`)
      }
      return { runId: String(run.id), agentsStarted: result.agentsStarted, result: result.value }
    } finally {
      await run.dispose()
    }
  }
}

function workflowName(value: string): string {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)) throw new Error(`invalid workflow name: ${value}`)
  return value
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max)
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
