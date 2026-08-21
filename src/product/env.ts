import { existsSync, readFileSync, statSync } from 'node:fs'
import { CONFIG_ENV_NAMES, SECRET_ENV_NAMES } from './constants.js'

export interface EnvFileLoad {
  readonly path: string
  readonly loaded: boolean
  readonly insecurePermissions: boolean
  readonly keysSet: readonly string[]
}

export interface CredentialPresence {
  readonly name: string
  readonly kind: 'secret' | 'config'
  readonly present: boolean
  readonly required: boolean
}

function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const cut = trimmed.startsWith('export ') ? trimmed.slice('export '.length) : trimmed
    const eq = cut.indexOf('=')
    if (eq <= 0) continue
    const key = cut.slice(0, eq).trim()
    let value = cut.slice(eq + 1)
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value
  }
  return out
}

export function inspectEnvFile(filePath: string): EnvFileLoad {
  if (!existsSync(filePath)) {
    return { path: filePath, loaded: false, insecurePermissions: false, keysSet: [] }
  }
  const mode = statSync(filePath).mode & 0o777
  const insecurePermissions = (mode & 0o077) !== 0
  const parsed = parseEnvFile(readFileSync(filePath, 'utf8'))
  const keysSet: string[] = []
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value
      keysSet.push(key)
    }
  }
  return { path: filePath, loaded: true, insecurePermissions, keysSet }
}

export function credentialInventory(): readonly CredentialPresence[] {
  return [
    ...SECRET_ENV_NAMES.map((name) => ({
      name,
      kind: 'secret' as const,
      required: false,
      present: Boolean(process.env[name]),
    })),
    ...CONFIG_ENV_NAMES.map((name) => ({
      name,
      kind: 'config' as const,
      required: false,
      present: Boolean(process.env[name]),
    })),
  ]
}

export function missingCredentialNames(inventory: readonly CredentialPresence[] = credentialInventory()): readonly string[] {
  return inventory.filter((item) => !item.present).map((item) => item.name)
}
