import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RuntimeContextError } from './runtime-context.js'

export const ASSISTANT_PROFILE_BUNDLES = Object.freeze(['@deepseek-ai/dsh-base', 'dsh-assistant'] as const)
export const REQUIRED_COMPOSED_IDS = Object.freeze(['dsh-assistant', 'agent', 'system-prompt'] as const)
export const PROTECTED_PLUGIN_IDS = Object.freeze(['dsh-assistant'] as const)

export interface ProfilePatchRow {
  readonly id?: string
  readonly disabled?: boolean
  readonly config?: unknown
}

export function assistantProfileManifestPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '../../profiles/assistant/package.json')
}

export function packagedAssistantBundles(manifestPath = assistantProfileManifestPath()): readonly string[] {
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
  const bundles = raw.dsh?.profile?.bundles
  if (!bundles?.length) throw new RuntimeContextError('assistant profile bundles are missing')
  return bundles
}

export function assertAssistantBundles(bundles: readonly string[]): void {
  if (bundles.length !== ASSISTANT_PROFILE_BUNDLES.length
    || ASSISTANT_PROFILE_BUNDLES.some((item, index) => bundles[index] !== item)) {
    throw new RuntimeContextError('assistant profile bundles are not the production adapter contract')
  }
}

export function assertComposedProfile(composedIds: readonly string[]): void {
  const product = composedIds.filter((id) => id === 'dsh-assistant')
  if (product.length !== 1) {
    throw new RuntimeContextError('composed profile must mount exactly one dsh-assistant bundle')
  }
  if (new Set(composedIds).size !== composedIds.length) {
    throw new RuntimeContextError('composed profile contains duplicate plugin ids')
  }
  for (const id of REQUIRED_COMPOSED_IDS) {
    if (!composedIds.includes(id)) {
      throw new RuntimeContextError(`composed profile is missing required id ${id}`)
    }
  }
}

export function assertProfilePatchSafe(patches: readonly ProfilePatchRow[]): void {
  for (const row of patches) {
    if (row.id !== undefined && (PROTECTED_PLUGIN_IDS as readonly string[]).includes(row.id) && row.disabled === true) {
      throw new RuntimeContextError(`profile patch cannot disable protected plugin ${row.id}`)
    }
    if (row.id === 'dsh-assistant' && row.config !== undefined && row.config !== null && typeof row.config === 'object') {
      const config = row.config as { governance?: unknown; registry?: unknown }
      if (config.governance === null || config.registry === null) {
        throw new RuntimeContextError('profile patch cannot remove protected governance or registry authority')
      }
    }
  }
}

export function assertSelectedProfile(profile: string): void {
  if (profile !== 'assistant') {
    throw new RuntimeContextError('unknown or invalid profile')
  }
}
