import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { composeEntries, loadOptionalPatches, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { RuntimeContextError } from './runtime-context.js'

export const GOVERNED_PROFILE_NAME = 'assistant'
export const GOVERNED_SAFE_OVERLAY = 'assistant-safe'
export const PROFILE_CONTRACT_SCHEMA_VERSION = 1

export interface ComposedProfileEntry {
  readonly id?: string
  readonly disabled?: boolean | null
  readonly config?: unknown
}

export interface GovernedProfileComposition {
  readonly name: string
  readonly bundles: readonly string[]
  readonly patches: readonly ComposedProfileEntry[]
  readonly entries: readonly ComposedProfileEntry[]
}

export function productPackageRoot(): string {
  return fileURLToPath(new URL('../..', import.meta.url))
}

export function governedProfilesRoot(): string {
  return process.env.TARS_NG_PROFILE_ROOT ?? path.join(productPackageRoot(), 'profiles')
}

export function activeComposedIds(entries: readonly ComposedProfileEntry[]): string[] {
  return entries.flatMap((row) => (typeof row.id === 'string' && row.disabled !== true ? [row.id] : []))
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as object).sort().map((key) => [key, stableJson((value as Record<string, unknown>)[key])]))
  }
  return value
}

export function profileIdentityOf(composition: GovernedProfileComposition): string {
  const active = composition.entries.flatMap((row) => {
    if (typeof row.id !== 'string' || row.disabled === true) return []
    return [{ id: row.id, config: stableJson(row.config ?? null) }]
  }).sort((left, right) => left.id.localeCompare(right.id))
  const payload = stableJson({
    schemaVersion: PROFILE_CONTRACT_SCHEMA_VERSION,
    name: composition.name,
    bundles: [...composition.bundles],
    active,
  })
  const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  return `v${PROFILE_CONTRACT_SCHEMA_VERSION}:${digest}`
}

function bundlePatches(packageDir: string) {
  const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as {
    name?: string
    dsh?: { bundle?: { patch?: string } }
  }
  const declared = manifest.dsh?.bundle?.patch
  if (typeof manifest.name !== 'string' || typeof declared !== 'string') {
    throw new RuntimeContextError(`profile bundle at ${packageDir} declares no dsh.bundle`)
  }
  return {
    packageName: manifest.name,
    patches: loadOverlayPatches('tars-ng', path.join(packageDir, declared)),
  }
}

export function loadGovernedAssistantComposition(options: { readonly recovery?: boolean } = {}): GovernedProfileComposition {
  const root = productPackageRoot()
  const profiles = governedProfilesRoot()
  const patchName = options.recovery === true ? GOVERNED_SAFE_OVERLAY : GOVERNED_PROFILE_NAME
  try {
    const baseDir = path.dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-base/package.json')))
    const base = bundlePatches(baseDir)
    const product = bundlePatches(root)
    const profilePatches = loadOptionalPatches('tars-ng', path.join(profiles, patchName, 'cordis.patch.yml'))
    if (profilePatches === undefined) {
      throw new RuntimeContextError(`shipped ${patchName} Profile patch is missing`)
    }
    const expectedBundles = ['@deepseek-ai/dsh-base', 'dsh-assistant'] as const
    const bundles = [base.packageName, product.packageName]
    if (bundles.length !== expectedBundles.length
      || expectedBundles.some((item, index) => bundles[index] !== item)) {
      throw new RuntimeContextError('assistant profile bundles are not the production adapter contract')
    }
    const entries = composeEntries([
      base.patches,
      product.patches,
      profilePatches,
    ]) as ComposedProfileEntry[]
    return {
      name: GOVERNED_PROFILE_NAME,
      bundles,
      patches: profilePatches as ComposedProfileEntry[],
      entries,
    }
  } catch (error) {
    throw new RuntimeContextError(error instanceof Error ? error.message : `failed to load the shipped ${patchName} Profile`)
  }
}

export function tryLoadGovernedAssistantComposition(options: { readonly recovery?: boolean } = {}):
  | { readonly ok: true; readonly composition: GovernedProfileComposition }
  | { readonly ok: false; readonly error: string } {
  try {
    return { ok: true, composition: loadGovernedAssistantComposition(options) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'failed to load the shipped Profile' }
  }
}
