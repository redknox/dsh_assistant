import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Hard bounds on the model-facing confined-file seam. Fail during the walk, not after collection. */
export const SANDBOX_MAX_FILE_BYTES = 256 * 1024
export const SANDBOX_MAX_LIST_ENTRIES = 200
export const SANDBOX_MAX_LIST_DEPTH = 8
export const SANDBOX_MAX_TASK_TITLE_CHARS = 200
export const SANDBOX_MAX_TASK_BODY_CHARS = 8 * 1024

export class ConfinedRootError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfinedRootError'
  }
}

function assertInside(rootReal: string, candidatePath: string): void {
  const rel = path.relative(rootReal, candidatePath)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ConfinedRootError(`path escapes confined root: ${candidatePath}`)
  }
}

function assertExistingRealsInside(rootReal: string, start: string): void {
  let current = start
  while (true) {
    if (existsSync(current)) {
      const real = realpathSync(current)
      assertInside(rootReal, real)
      if (lstatSync(current).isSymbolicLink()) {
        throw new ConfinedRootError(`symlink is not allowed inside confined root: ${current}`)
      }
    }
    const parent = path.dirname(current)
    if (parent === current) break
    const parentRel = path.relative(rootReal, parent)
    if (parentRel.startsWith('..') || path.isAbsolute(parentRel)) break
    current = parent
  }
}

export function resolveConfined(root: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath === '') {
    throw new ConfinedRootError('confined-relative path is required')
  }
  const unix = relativePath.replaceAll('\\', '/')
  if (path.isAbsolute(relativePath) || path.isAbsolute(unix) || unix.startsWith('/')) {
    throw new ConfinedRootError(`absolute path is not allowed: ${relativePath}`)
  }
  const parts = unix.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new ConfinedRootError(`path traversal is not allowed: ${relativePath}`)
  }
  const rootReal = existsSync(root) ? realpathSync(root) : path.resolve(root)
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
    throw new ConfinedRootError('confined root itself must not be a symlink')
  }
  const dest = path.resolve(rootReal, ...parts)
  assertInside(rootReal, dest)
  assertExistingRealsInside(rootReal, dest)
  return dest
}

export function listConfinedTextFiles(root: string, prefix = '', extension = '.md'): string[] {
  const rootReal = existsSync(root) ? realpathSync(root) : path.resolve(root)
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
    throw new ConfinedRootError('confined root itself must not be a symlink')
  }
  const files: string[] = []
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > SANDBOX_MAX_LIST_DEPTH) {
      throw new ConfinedRootError(`sandbox listing exceeded the depth bound of ${SANDBOX_MAX_LIST_DEPTH}`)
    }
    for (const entry of readdirSync(dir)) {
      const relative = rel === '' ? entry : `${rel}/${entry}`
      const full = path.join(dir, entry)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) walk(full, relative, depth + 1)
      else if (stat.isFile() && (extension === '' || relative.endsWith(extension))) {
        if (files.length >= SANDBOX_MAX_LIST_ENTRIES) {
          throw new ConfinedRootError(`sandbox listing exceeded the entry bound of ${SANDBOX_MAX_LIST_ENTRIES}`)
        }
        files.push(relative)
      }
    }
  }
  const start = prefix === '' ? rootReal : resolveConfined(root, prefix)
  const startRel = prefix.replaceAll('\\', '/').replace(/\/$/, '')
  if (existsSync(start) && lstatSync(start).isDirectory()) walk(start, startRel, 0)
  return files.sort()
}

export function readConfinedText(root: string, relativePath: string): string {
  const dest = resolveConfined(root, relativePath)
  const stat = lstatSync(dest)
  if (!stat.isFile()) {
    throw new ConfinedRootError(`file not found: ${relativePath}`)
  }
  if (stat.size > SANDBOX_MAX_FILE_BYTES) {
    throw new ConfinedRootError(`sandbox file exceeds the ${SANDBOX_MAX_FILE_BYTES} byte bound`)
  }
  const text = readFileSync(dest, 'utf8')
  if (Buffer.byteLength(text, 'utf8') > SANDBOX_MAX_FILE_BYTES) {
    throw new ConfinedRootError(`sandbox file exceeds the ${SANDBOX_MAX_FILE_BYTES} byte bound`)
  }
  return text
}

export function writeConfinedText(root: string, relativePath: string, content: string): void {
  if (Buffer.byteLength(content, 'utf8') > SANDBOX_MAX_FILE_BYTES) {
    throw new ConfinedRootError(`sandbox write exceeds the ${SANDBOX_MAX_FILE_BYTES} byte bound`)
  }
  const dest = resolveConfined(root, relativePath)
  const rootReal = existsSync(root) ? realpathSync(root) : path.resolve(root)
  const parent = path.dirname(dest)
  assertExistingRealsInside(rootReal, parent)
  mkdirSync(parent, { recursive: true })
  assertInside(rootReal, realpathSync(parent))
  writeFileSync(dest, content)
}

export function deleteConfinedText(root: string, relativePath: string): void {
  const dest = resolveConfined(root, relativePath)
  if (!existsSync(dest) || !lstatSync(dest).isFile()) {
    throw new ConfinedRootError(`file not found: ${relativePath}`)
  }
  unlinkSync(dest)
}
