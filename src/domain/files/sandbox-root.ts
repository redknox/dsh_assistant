import { existsSync, lstatSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type SandboxRootInspection =
  | { readonly configured: false }
  | { readonly configured: true; readonly ok: true; readonly root: string }
  | { readonly configured: true; readonly ok: false; readonly reason: string }

export function expandUserPath(value: string): string {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  return path.resolve(value)
}

/** Resolve an operator-configured confined sandbox. The directory must already exist and must not be a symlink. */
export function inspectSandboxRoot(raw: string | undefined): SandboxRootInspection {
  if (typeof raw !== 'string' || raw.trim() === '') return { configured: false }
  const expanded = expandUserPath(raw.trim())
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
