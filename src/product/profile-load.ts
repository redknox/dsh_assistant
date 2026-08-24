import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { composeEntries, loadOptionalPatches, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { RuntimeContextError } from './runtime-context.js'

export const GOVERNED_PROFILE_NAME = 'assistant'
export const GOVERNED_SAFE_OVERLAY = 'assistant-safe'

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

export function activeComposedIds(entries: readonly ComposedProfileEntry[]): string[] {
  return entries.flatMap((row) => (typeof row.id === 'string' && row.disabled !== true ? [row.id] : []))
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

export function loadGovernedAssistantComposition(options: { readonly safeMode?: boolean } = {}): GovernedProfileComposition {
  const root = productPackageRoot()
  try {
    const baseDir = path.dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-base/package.json')))
    const base = bundlePatches(baseDir)
    const product = bundlePatches(root)
    const profilePatches = loadOptionalPatches('tars-ng', path.join(root, 'profiles', GOVERNED_PROFILE_NAME, 'cordis.patch.yml')) ?? []
    const overlay = options.safeMode === true
      ? (loadOptionalPatches('tars-ng', path.join(root, 'profiles', GOVERNED_SAFE_OVERLAY, 'cordis.patch.yml')) ?? [])
      : []
    const expectedBundles = ['@deepseek-ai/dsh-base', 'dsh-assistant'] as const
    const bundles = [base.packageName, product.packageName]
    if (bundles.length !== expectedBundles.length
      || expectedBundles.some((item, index) => bundles[index] !== item)) {
      throw new RuntimeContextError('assistant profile bundles are not the production adapter contract')
    }
    const patches = [...profilePatches, ...overlay] as ComposedProfileEntry[]
    const entries = composeEntries([
      base.patches,
      product.patches,
      profilePatches,
      overlay,
    ]) as ComposedProfileEntry[]
    return {
      name: GOVERNED_PROFILE_NAME,
      bundles,
      patches,
      entries,
    }
  } catch (error) {
    throw new RuntimeContextError(error instanceof Error ? error.message : 'failed to load the shipped assistant Profile')
  }
}
