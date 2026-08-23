import { mkdirSync } from 'node:fs'
import path from 'node:path'

export const SELF_EXTENSION_SCHEMA_VERSION = 1

export interface SelfExtensionHome {
  readonly root: string
  readonly authorityPath: string
  readonly candidateIndexPath: string
  readonly candidateArea: string
  readonly reviewLineagePath: string
  readonly workbenchPath: string
}

export function resolveAssistantHome(explicit?: string): string | undefined {
  if (explicit !== undefined && explicit !== '') return path.resolve(explicit)
  for (const name of ['TARS_NG_HOME', 'DSH_ASSISTANT_HOME'] as const) {
    const env = process.env[name]
    if (typeof env === 'string' && env !== '') return path.resolve(env)
  }
  return undefined
}

export function selfExtensionPaths(home: string): SelfExtensionHome {
  const root = path.join(path.resolve(home), 'self-extension')
  return {
    root,
    authorityPath: path.join(root, 'authority.json'),
    candidateIndexPath: path.join(root, 'candidates', 'index.json'),
    candidateArea: path.join(root, 'candidates'),
    reviewLineagePath: path.join(root, 'review-lineage.json'),
    workbenchPath: path.join(root, 'workbench.json'),
  }
}

export function ensureSelfExtensionHome(home: string): SelfExtensionHome {
  const paths = selfExtensionPaths(home)
  mkdirSync(paths.candidateArea, { recursive: true })
  return paths
}
