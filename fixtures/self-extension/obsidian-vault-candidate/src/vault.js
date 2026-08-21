import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export class VaultEscapeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'VaultEscapeError'
  }
}

function assertInside(rootReal, candidatePath) {
  const rel = path.relative(rootReal, candidatePath)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new VaultEscapeError(`path escapes vault root: ${candidatePath}`)
  }
}

/** Resolve a vault-relative note path. Rejects absolute paths, `..`, and symlink escapes. */
export function resolveInVault(vaultRoot, relativePath) {
  if (typeof relativePath !== 'string' || relativePath === '') {
    throw new VaultEscapeError('vault-relative path is required')
  }
  const unix = relativePath.replaceAll('\\', '/')
  if (path.isAbsolute(relativePath) || path.isAbsolute(unix) || unix.startsWith('/')) {
    throw new VaultEscapeError(`absolute path is not allowed: ${relativePath}`)
  }
  const parts = unix.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new VaultEscapeError(`path traversal is not allowed: ${relativePath}`)
  }
  const rootReal = existsSync(vaultRoot) ? realpathSync(vaultRoot) : path.resolve(vaultRoot)
  const dest = path.resolve(rootReal, ...parts)
  assertInside(rootReal, dest)
  if (existsSync(dest) && lstatSync(dest).isSymbolicLink()) {
    assertInside(rootReal, realpathSync(dest))
  }
  return dest
}

export function listMarkdown(vaultRoot) {
  const rootReal = existsSync(vaultRoot) ? realpathSync(vaultRoot) : path.resolve(vaultRoot)
  const files = []
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir)) {
      const relative = prefix === '' ? entry : `${prefix}/${entry}`
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) walk(full, relative)
      else if (relative.endsWith('.md')) files.push(relative)
    }
  }
  walk(rootReal, '')
  return files.sort()
}

export function readVaultFile(vaultRoot, relativePath) {
  return readFileSync(resolveInVault(vaultRoot, relativePath), 'utf8')
}

export function writeVaultFile(vaultRoot, relativePath, content) {
  const dest = resolveInVault(vaultRoot, relativePath)
  mkdirSync(path.dirname(dest), { recursive: true })
  writeFileSync(dest, content)
  return dest
}
