import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const VALIDATION_TEST_TIMEOUT_MS = 30_000

const PRELOAD_SOURCE = `function deny(kind) {
  const error = new Error('validation runner denies ' + kind)
  error.name = 'ValidationDeniedError'
  error.code = 'ERR_VALIDATION_DENIED'
  throw error
}

function lock(mod, methods) {
  for (const name of methods) {
    if (typeof mod[name] === 'function') {
      Object.defineProperty(mod, name, {
        configurable: false,
        writable: false,
        value: () => deny(name),
      })
    }
  }
}

const net = await import('node:net')
lock(net.default ?? net, ['connect', 'createConnection', 'createServer'])

const http = await import('node:http')
lock(http.default ?? http, ['request', 'get', 'createServer'])

const https = await import('node:https')
lock(https.default ?? https, ['request', 'get', 'createServer'])

const dgram = await import('node:dgram')
lock(dgram.default ?? dgram, ['createSocket'])

const tls = await import('node:tls')
lock(tls.default ?? tls, ['connect', 'createServer'])

const dns = await import('node:dns')
lock(dns.default ?? dns, ['lookup', 'resolve', 'resolve4', 'resolve6'])
if (dns.promises) lock(dns.promises, ['lookup', 'resolve', 'resolve4', 'resolve6'])

const child = await import('node:child_process')
lock(child.default ?? child, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])

globalThis.fetch = () => deny('network')
`

/** Host-owned env only. Candidate runtime permissions and host secrets are not inherited. */
export function restrictedValidationEnv(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin',
    TZ: 'UTC',
    LANG: 'C',
    NODE_ENV: 'validation',
  }
}

export function runnerUnavailable(error: { message?: string; stderr?: string }): boolean {
  const text = `${error.stderr ?? ''}\n${error.message ?? ''}`
  return /bad option|unknown option|not supported|is not a valid/i.test(text)
}

export function runRestrictedCandidateTests(root: string, testFiles: readonly string[]): string {
  const workspace = existsSync(root) ? realpathSync(root) : path.resolve(root)
  const allowRoot = workspace.endsWith(path.sep) ? workspace : `${workspace}${path.sep}`
  const preloadDir = path.join(workspace, '.dsh')
  mkdirSync(preloadDir, { recursive: true })
  const preload = path.join(preloadDir, 'validation-preload.js')
  const chunks: string[] = []
  for (const file of testFiles) {
    writeFileSync(preload, PRELOAD_SOURCE)
    chunks.push(execFileSync(process.execPath, [
      '--permission',
      `--allow-fs-read=${allowRoot}`,
      `--allow-fs-write=${allowRoot}`,
      `--import=${pathToFileURL(preload).href}`,
      path.join(workspace, file),
    ], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: VALIDATION_TEST_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: restrictedValidationEnv(),
    }))
  }
  return chunks.join('\n')
}
