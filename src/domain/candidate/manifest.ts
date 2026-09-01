import { parseCapabilityId, parseOwnerId, parsePermission, parseVersion } from '../registry/normalize.js'
import type { ExtensionProvenance } from '../registry/types.js'
import type { ResolutionKind, ResolutionReview } from '../resolution/types.js'
import { CandidateContractError } from './errors.js'
import type { CandidateManifest, CandidateManifestInput, CandidateWorkflowDeclaration, OperationalEffects, PluginCapabilityDependency, RemoteSideEffect } from './types.js'
import { PLUGIN_DEPENDENCY_STRENGTHS, REMOTE_SIDE_EFFECTS } from './types.js'

const CHANGE_KINDS: readonly ResolutionKind[] = [
  'configure',
  'evolve-owner',
  'adopt-existing',
  'implement-provider',
  'new-plugin',
]

const emptyEffects = (): OperationalEffects => ({
  filesystem: [],
  network: [],
  process: [],
  secrets: [],
  externalSystems: [],
  remoteSideEffect: 'none',
})

function resolveRemoteSideEffect(effects: Partial<OperationalEffects>): RemoteSideEffect {
  if (effects.remoteSideEffect !== undefined && (REMOTE_SIDE_EFFECTS as readonly string[]).includes(effects.remoteSideEffect)) {
    return effects.remoteSideEffect
  }
  const external = (effects.network ?? []).length > 0 || (effects.secrets ?? []).length > 0
  return external ? 'mutate' : 'none'
}

export function assertChangeReview(review: ResolutionReview): void {
  if (!CHANGE_KINDS.includes(review.kind)) {
    throw new CandidateContractError(`resolution kind ${review.kind} does not justify a candidate`)
  }
}

export function defaultProvenance(review: ResolutionReview, owner: string): ExtensionProvenance {
  if (owner.startsWith('third-party/')) {
    return { kind: 'third-party', origin: 'import' }
  }
  if (review.kind === 'new-plugin' || owner.startsWith('generated/')) {
    return { kind: 'generated', origin: 'assistant' }
  }
  return { kind: 'managed', origin: 'assistant' }
}

export function normalizeManifest(
  review: ResolutionReview,
  owner: string,
  version: string,
  baseVersion: string | undefined,
  provenance: ExtensionProvenance,
  input: CandidateManifestInput = {},
): CandidateManifest {
  assertChangeReview(review)
  const effects = input.effects ?? {}
  const permissions = (input.permissions ?? []).map(parsePermission)
  const runtimeContractVersion = resolveRuntimeContractVersion(provenance.kind, input.runtimeContractVersion)
  return {
    owner: parseOwnerId(owner),
    version: parseVersion(version),
    provenance,
    baseVersion: baseVersion === undefined ? undefined : parseVersion(baseVersion),
    resolutionKind: review.kind,
    resolutionCapability: parseCapabilityId(review.capability),
    resolutionNeed: review.need,
    capabilities: (input.capabilities ?? []).map((item) => parseCapabilityId(item)),
    permissions,
    runtimeSeams: [...(input.runtimeSeams ?? [])],
    tools: [...(input.tools ?? [])],
    services: [...(input.services ?? [])],
    providers: [...(input.providers ?? [])],
    workflows: normalizeWorkflows(input.workflows),
    secrets: [...(input.secrets ?? [])],
    configRequired: [...(input.configRequired ?? [])],
    effects: {
      filesystem: [...(effects.filesystem ?? [])],
      network: [...(effects.network ?? [])],
      process: [...(effects.process ?? [])],
      secrets: [...(effects.secrets ?? [])],
      externalSystems: [...(effects.externalSystems ?? [])],
      remoteSideEffect: resolveRemoteSideEffect(effects),
    },
    entryPoints: [...(input.entryPoints ?? [])],
    validationTasks: (input.validationTasks ?? []).map((task) => ({
      name: task.name,
      argv: task.argv === undefined ? undefined : [...task.argv],
      script: task.script,
    })),
    riskModel: input.riskModel,
    runtimeContractVersion,
    pluginDependencies: normalizePluginDependencies(input.pluginDependencies),
  }
}

function normalizeWorkflows(input?: readonly CandidateWorkflowDeclaration[]): readonly CandidateWorkflowDeclaration[] {
  const workflows = input ?? []
  const names = new Set<string>()
  return workflows.map((workflow, index) => {
    if (!workflow || typeof workflow !== 'object') throw new CandidateContractError(`malformed workflows[${index}]`)
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(workflow.name) || names.has(workflow.name)) {
      throw new CandidateContractError(`invalid or duplicate workflows[${index}].name`)
    }
    names.add(workflow.name)
    if (typeof workflow.description !== 'string' || workflow.description.trim() === '' || workflow.description.length > 400) {
      throw new CandidateContractError(`invalid workflows[${index}].description`)
    }
    if (!/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/.test(workflow.script)) {
      throw new CandidateContractError(`invalid workflows[${index}].script`)
    }
    if (!/\.(?:js|mjs|cjs)$/.test(workflow.script)) {
      throw new CandidateContractError(`workflows[${index}].script must be a JavaScript file`)
    }
    if (workflow.intent !== 'read' && workflow.intent !== 'mutate') throw new CandidateContractError(`invalid workflows[${index}].intent`)
    if (!Number.isSafeInteger(workflow.maxInputBytes) || workflow.maxInputBytes < 2 || workflow.maxInputBytes > 262_144) {
      throw new CandidateContractError(`invalid workflows[${index}].maxInputBytes`)
    }
    if (!Number.isSafeInteger(workflow.maxTotalAgents) || workflow.maxTotalAgents < 1 || workflow.maxTotalAgents > 32) {
      throw new CandidateContractError(`invalid workflows[${index}].maxTotalAgents`)
    }
    const phaseTitles = new Set<string>()
    for (const [phaseIndex, phase] of (workflow.phases ?? []).entries()) {
      if (!phase || typeof phase.title !== 'string' || phase.title.trim() === '' || phase.title.length > 120) {
        throw new CandidateContractError(`invalid workflows[${index}].phases[${phaseIndex}].title`)
      }
      if (phaseTitles.has(phase.title)) throw new CandidateContractError(`duplicate workflows[${index}].phases title`)
      phaseTitles.add(phase.title)
      if (phase.detail !== undefined && (typeof phase.detail !== 'string' || phase.detail.trim() === '' || phase.detail.length > 300)) {
        throw new CandidateContractError(`invalid workflows[${index}].phases[${phaseIndex}].detail`)
      }
    }
    const inputNames = new Set<string>()
    for (const [fieldIndex, field] of (workflow.inputFields ?? []).entries()) {
      if (!field || !/^[A-Za-z][A-Za-z0-9_]*$/.test(field.name) || field.name.length > 120 || inputNames.has(field.name)) {
        throw new CandidateContractError(`invalid or duplicate workflows[${index}].inputFields[${fieldIndex}].name`)
      }
      inputNames.add(field.name)
      if (typeof field.required !== 'boolean') {
        throw new CandidateContractError(`invalid workflows[${index}].inputFields[${fieldIndex}].required`)
      }
      if (field.description !== undefined && (typeof field.description !== 'string' || field.description.trim() === '' || field.description.length > 300)) {
        throw new CandidateContractError(`invalid workflows[${index}].inputFields[${fieldIndex}].description`)
      }
    }
    return {
      name: workflow.name,
      description: workflow.description,
      ...(workflow.whenToUse ? { whenToUse: workflow.whenToUse.slice(0, 400) } : {}),
      ...(workflow.phases ? { phases: workflow.phases.map((phase) => ({ title: phase.title, ...(phase.detail ? { detail: phase.detail } : {}) })) } : {}),
      script: workflow.script,
      intent: workflow.intent,
      maxInputBytes: workflow.maxInputBytes,
      maxTotalAgents: workflow.maxTotalAgents,
      ...(workflow.inputFields ? { inputFields: workflow.inputFields.map((field) => ({ name: field.name, required: field.required, ...(field.description ? { description: field.description } : {}) })) } : {}),
    }
  })
}

function normalizePluginDependencies(input?: readonly PluginCapabilityDependency[]): readonly PluginCapabilityDependency[] {
  if (input === undefined) return []
  return input.map((item, index) => {
    if (!item || typeof item.capability !== 'string' || !(PLUGIN_DEPENDENCY_STRENGTHS as readonly string[]).includes(item.strength)) {
      throw new CandidateContractError(`malformed pluginDependencies[${index}]`)
    }
    return { capability: parseCapabilityId(item.capability), strength: item.strength }
  })
}

function resolveRuntimeContractVersion(provenanceKind: string, requested?: string): string | undefined {
  if (requested === '') return undefined
  if (requested !== undefined) return requested
  return provenanceKind === 'generated' || provenanceKind === 'third-party'
    ? 'generated-extension-api/v1'
    : undefined
}

export function emptyOperationalEffects(): OperationalEffects {
  return emptyEffects()
}
