import { existsSync, lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { WorkspaceEscapeError } from './errors.js'

const META_DIR = '.dsh'

export function candidateDirName(owner: string, version: string): string {
  return `${owner.replaceAll('/', '--')}@${version}`
}

export function metaDirName(): string {
  return META_DIR
}

function assertInside(rootReal: string, candidatePath: string): void {
  const rel = path.relative(rootReal, candidatePath)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new WorkspaceEscapeError(`path escapes candidate workspace: ${candidatePath}`)
  }
}

function assertExistingRealsInside(rootReal: string, start: string): void {
  let current = start
  while (true) {
    if (existsSync(current)) {
      assertInside(rootReal, realpathSync(current))
    }
    const parent = path.dirname(current)
    if (parent === current) break
    const parentRel = path.relative(rootReal, parent)
    if (parentRel.startsWith('..') || path.isAbsolute(parentRel)) break
    current = parent
  }
}

/** Resolve a candidate-relative path. Rejects absolute paths, `..`, and symlink escapes. */
export function resolveInsideRoot(root: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath === '') {
    throw new WorkspaceEscapeError('path is required')
  }
  const unix = relativePath.replaceAll('\\', '/')
  if (path.isAbsolute(relativePath) || path.isAbsolute(unix) || unix.startsWith('/')) {
    throw new WorkspaceEscapeError(`absolute path is not allowed: ${relativePath}`)
  }
  const parts = unix.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new WorkspaceEscapeError(`path traversal is not allowed: ${relativePath}`)
  }
  const rootReal = existsSync(root) ? realpathSync(root) : path.resolve(root)
  const dest = path.resolve(rootReal, ...parts)
  assertInside(rootReal, dest)
  assertExistingRealsInside(rootReal, dest)
  if (existsSync(dest) && lstatSync(dest).isSymbolicLink()) {
    assertInside(rootReal, realpathSync(dest))
  }
  return dest
}

export function isMetaPath(relativePath: string): boolean {
  return relativePath === META_DIR || relativePath.startsWith(`${META_DIR}/`)
}
