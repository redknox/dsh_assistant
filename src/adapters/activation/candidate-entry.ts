import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

function packageEntries(root: string): string[] {
  const pkgPath = path.join(root, 'package.json')
  if (!existsSync(pkgPath)) return []
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      main?: string
      exports?: string | { '.'?: string | { import?: string; default?: string } }
    }
    const found: string[] = []
    if (typeof pkg.exports === 'string') found.push(pkg.exports)
    if (pkg.exports && typeof pkg.exports === 'object') {
      const exp = pkg.exports['.']
      if (typeof exp === 'string') found.push(exp)
      if (exp && typeof exp === 'object') {
        if (exp.import) found.push(exp.import)
        if (exp.default) found.push(exp.default)
      }
    }
    if (pkg.main) found.push(pkg.main)
    return found
  } catch {
    return []
  }
}

/** Resolve a sealed candidate's plugin entry from workspace/manifest/package metadata. */
export function resolveCandidateEntry(workspaceRoot: string, entryPoints: readonly string[] = []): string {
  const relatives = [
    ...entryPoints,
    ...packageEntries(workspaceRoot),
    'src/index.js',
    'src/plugin.js',
    'index.js',
    'plugin.js',
    'src/index.ts',
    'src/plugin.ts',
  ]
  const seen = new Set<string>()
  const root = path.resolve(workspaceRoot)
  for (const rel of relatives) {
    if (rel === undefined || rel === '' || seen.has(rel)) continue
    seen.add(rel)
    const unix = rel.replaceAll('\\', '/')
    if (path.isAbsolute(rel) || unix.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      continue
    }
    const abs = path.resolve(root, ...unix.split('/'))
    const inside = abs === root || abs.startsWith(`${root}${path.sep}`)
    if (!inside || !existsSync(abs)) continue
    return abs
  }
  throw new Error('candidate workspace has no mountable plugin entry')
}
