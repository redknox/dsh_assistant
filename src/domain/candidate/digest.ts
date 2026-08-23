import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export function digestFiles(
  root: string,
  relativePaths: readonly string[],
  extras: readonly { readonly name: string; readonly payload: string }[] = [],
): string {
  const hash = createHash('sha256')
  for (const relative of [...relativePaths].sort()) {
    hash.update(relative)
    hash.update('\0')
    hash.update(readFileSync(path.join(root, relative)))
    hash.update('\0')
  }
  for (const extra of extras) {
    hash.update(extra.name)
    hash.update('\0')
    hash.update(extra.payload)
    hash.update('\0')
  }
  return hash.digest('hex')
}

export function contractDigestExtras(version?: string): readonly { readonly name: string; readonly payload: string }[] {
  if (version === undefined || version === '') return []
  return [{ name: 'runtimeContractVersion', payload: version }]
}
