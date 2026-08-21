import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export function digestFiles(root: string, relativePaths: readonly string[]): string {
  const hash = createHash('sha256')
  for (const relative of [...relativePaths].sort()) {
    hash.update(relative)
    hash.update('\0')
    hash.update(readFileSync(path.join(root, relative)))
    hash.update('\0')
  }
  return hash.digest('hex')
}
