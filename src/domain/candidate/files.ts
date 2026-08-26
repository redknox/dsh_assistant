import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import path from 'node:path'
import { isMetaPath, resolveInsideRoot } from './paths.js'

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

export function listSourceFiles(root: string): string[] {
  const files: string[] = []
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir)) {
      const relative = prefix === '' ? entry : `${prefix}/${entry}`
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) walk(full, relative)
      else if (!isMetaPath(relative)) files.push(relative)
    }
  }
  walk(root, '')
  return files.sort()
}

export function writeSourceFile(root: string, relativePath: string, content: string): void {
  const dest = resolveInsideRoot(root, relativePath)
  ensureDir(path.dirname(dest))
  writeFileSync(dest, content)
}

export function writeSourceFileSynced(root: string, relativePath: string, content: string): void {
  const dest = resolveInsideRoot(root, relativePath)
  ensureDir(path.dirname(dest))
  const fd = openSync(dest, 'w')
  try {
    writeSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function fsyncPath(target: string): void {
  const fd = openSync(target, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function readSourceFile(root: string, relativePath: string): string {
  return readFileSync(resolveInsideRoot(root, relativePath), 'utf8')
}

export function removeTree(root: string): void {
  rmSync(root, { recursive: true, force: true })
}
