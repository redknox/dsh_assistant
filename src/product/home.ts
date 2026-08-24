import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PRODUCT_CONFIG_SCHEMA_VERSION, PRODUCT_STATE_SCHEMA_VERSION } from './constants.js'
import { readProductRuntimeConfig, type ProductRuntimeConfig } from './runtime-context.js'

export interface ProductHomeLayout {
  readonly root: string
  readonly config: string
  readonly data: string
  readonly state: string
  readonly logs: string
  readonly backups: string
  readonly generated: string
  readonly envFile: string
  readonly productConfigFile: string
  readonly memoryFile: string
  readonly logFile: string
  readonly pidFile: string
  readonly lastStatusFile: string
  readonly runtimeLockDir: string
  readonly runtimeIdentityFile: string
}

export interface ProductUserConfig {
  readonly schemaVersion: number
  readonly allowFixtures: boolean
  readonly runtime?: ProductRuntimeConfig
}

export function resolveProductHome(explicit?: string): string {
  if (explicit !== undefined && explicit !== '') return path.resolve(explicit)
  const tars = process.env.TARS_NG_HOME
  if (typeof tars === 'string' && tars !== '') return path.resolve(tars)
  const legacy = process.env.DSH_ASSISTANT_HOME
  if (typeof legacy === 'string' && legacy !== '') return path.resolve(legacy)
  const xdg = process.env.XDG_DATA_HOME
  const dataRoot = typeof xdg === 'string' && xdg !== '' ? xdg : path.join(os.homedir(), '.local', 'share')
  return path.join(dataRoot, 'tars-ng')
}

export function productHomeLayout(root: string): ProductHomeLayout {
  const resolved = path.resolve(root)
  const config = path.join(resolved, 'config')
  return {
    root: resolved,
    config,
    data: path.join(resolved, 'data'),
    state: path.join(resolved, 'state'),
    logs: path.join(resolved, 'logs'),
    backups: path.join(resolved, 'backups'),
    generated: path.join(resolved, 'generated'),
    envFile: path.join(config, 'env'),
    productConfigFile: path.join(config, 'product.json'),
    memoryFile: path.join(resolved, 'data', 'memory.json'),
    logFile: path.join(resolved, 'logs', 'tars-ng.log'),
    pidFile: path.join(resolved, 'state', 'tars-ng.pid'),
    lastStatusFile: path.join(resolved, 'state', 'last-status.json'),
    runtimeLockDir: path.join(resolved, 'state', 'runtime.lock'),
    runtimeIdentityFile: path.join(resolved, 'state', 'runtime.lock', 'identity.json'),
  }
}

export function isSafeRuntimePid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0
}

export function processAlive(pid: number): boolean {
  if (!isSafeRuntimePid(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function xdgConfigEnvPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const configRoot = typeof xdg === 'string' && xdg !== '' ? xdg : path.join(os.homedir(), '.config')
  return path.join(configRoot, 'tars-ng', 'env')
}

/** Create the product home with owner-only permissions. Does not delete existing state. */
export function ensureProductHome(root: string): ProductHomeLayout {
  const initial = productHomeLayout(root)
  for (const dir of [initial.root, initial.config, initial.data, initial.state, initial.logs, initial.backups, initial.generated]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
      chmodSync(dir, 0o700)
    } catch {
      // chmod may fail on some filesystems; directory still exists.
    }
  }
  let normalized = initial.root
  try {
    normalized = realpathSync(initial.root)
  } catch {
    normalized = path.resolve(initial.root)
  }
  return productHomeLayout(normalized)
}

export function readProductUserConfig(layout: ProductHomeLayout): { config: ProductUserConfig; warning?: string } {
  if (!existsSync(layout.productConfigFile)) {
    return { config: { schemaVersion: PRODUCT_CONFIG_SCHEMA_VERSION, allowFixtures: false } }
  }
  const raw = JSON.parse(readFileSync(layout.productConfigFile, 'utf8')) as { schemaVersion?: unknown; allowFixtures?: unknown; runtime?: unknown }
  const schemaVersion = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : PRODUCT_CONFIG_SCHEMA_VERSION
  if (schemaVersion > PRODUCT_CONFIG_SCHEMA_VERSION) {
    throw new Error(`unsupported product config schema ${schemaVersion}; this TARS-NG build supports ${PRODUCT_CONFIG_SCHEMA_VERSION}`)
  }
  return {
    config: {
      schemaVersion,
      allowFixtures: raw.allowFixtures === true,
      ...(readProductRuntimeConfig(raw) ? { runtime: readProductRuntimeConfig(raw) } : {}),
    },
  }
}

export function writeLastStatus(layout: ProductHomeLayout, status: unknown): void {
  writeFileSync(layout.lastStatusFile, `${JSON.stringify({ schemaVersion: PRODUCT_STATE_SCHEMA_VERSION, status }, null, 2)}\n`, { mode: 0o600 })
}

export function readLastStatus(layout: ProductHomeLayout): unknown {
  if (!existsSync(layout.lastStatusFile)) return undefined
  const raw = JSON.parse(readFileSync(layout.lastStatusFile, 'utf8')) as { schemaVersion?: unknown; status?: unknown }
  if (typeof raw.schemaVersion === 'number' && raw.schemaVersion > PRODUCT_STATE_SCHEMA_VERSION) {
    throw new Error(`unsupported product state schema ${raw.schemaVersion}`)
  }
  return raw.status
}
