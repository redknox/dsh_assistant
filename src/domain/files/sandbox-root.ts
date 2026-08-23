import { existsSync, lstatSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type SandboxRootInspection =
  | { readonly configured: false }
  | { readonly configured: true; readonly ok: true; readonly root: string }
  | { readonly configured: true; readonly ok: false; readonly reason: string }

function isExplicitHomePath(value: string): boolean {
  return value === '~' || value.startsWith('~/')
}

export function expandUserPath(value: string): string {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  return path.isAbsolute(value) ? path.normalize(value) : value
}

/** Resolve an operator-configured confined sandbox. The directory must already exist and must not be a symlink. */
export function inspectSandboxRoot(raw: string | undefined): SandboxRootInspection {
  if (typeof raw !== 'string' || raw.trim() === '') return { configured: false }
  const trimmed = raw.trim()
  if (!isExplicitHomePath(trimmed) && !path.isAbsolute(trimmed)) {
    return { configured: true, ok: false, reason: 'sandbox root must be an absolute path' }
  }
  const expanded = expandUserPath(trimmed)
  if (!path.isAbsolute(expanded)) {
    return { configured: true, ok: false, reason: 'sandbox root must be an absolute path' }
  }
  if (!existsSync(expanded)) {
    return { configured: true, ok: false, reason: 'sandbox root does not exist' }
  }
  const stat = lstatSync(expanded)
  if (stat.isSymbolicLink()) {
    return { configured: true, ok: false, reason: 'sandbox root must not be a symlink' }
  }
  if (!stat.isDirectory()) {
    return { configured: true, ok: false, reason: 'sandbox root must be a directory' }
  }
  return { configured: true, ok: true, root: realpathSync(expanded) }
}
