import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DSH_RUNTIME_PACKAGES, SUPPORTED_DSH_RELEASE } from './constants.js'

const require = createRequire(import.meta.url)

export interface CompatibilityReport {
  readonly ok: boolean
  readonly productVersion: string
  readonly nodeVersion: string
  readonly nodeSupported: boolean
  readonly dshSupported: string
  readonly dshFound: Record<string, string>
  readonly problems: readonly string[]
}

export function productPackageDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
}

export function readProductVersion(): string {
  const pkg = JSON.parse(readFileSync(path.join(productPackageDir(), 'package.json'), 'utf8')) as { version: string }
  return pkg.version
}

export function nodeMajor(version = process.versions.node): number {
  const major = Number.parseInt(version.split('.')[0] ?? '0', 10)
  return Number.isFinite(major) ? major : 0
}

export function inspectCompatibility(): CompatibilityReport {
  const problems: string[] = []
  const nodeVersion = process.versions.node
  const nodeSupported = nodeMajor(nodeVersion) >= 22
  if (!nodeSupported) problems.push(`Node ${nodeVersion} is unsupported; TARS-NG requires Node >=22`)

  const dshFound: Record<string, string> = {}
  for (const name of DSH_RUNTIME_PACKAGES) {
    try {
      const pkg = require(`${name}/package.json`) as { version?: string }
      const version = pkg.version ?? 'unknown'
      dshFound[name] = version
      if (name.startsWith('@deepseek-ai/dsh-') && version !== SUPPORTED_DSH_RELEASE) {
        problems.push(`${name}@${version} is outside the supported DSH release ${SUPPORTED_DSH_RELEASE}`)
      }
    } catch {
      problems.push(`${name} is not installed; TARS-NG does not require a separate DSH clone, but npm must install this dependency`)
    }
  }
  return {
    ok: problems.length === 0,
    productVersion: readProductVersion(),
    nodeVersion,
    nodeSupported,
    dshSupported: SUPPORTED_DSH_RELEASE,
    dshFound,
    problems,
  }
}
