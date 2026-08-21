import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { detectOsNetworkSandbox, wrapWithOsNetworkSandbox } from './os-sandbox.js'

export const VALIDATION_TEST_TIMEOUT_MS = 30_000
export const SANDBOX_UNAVAILABLE = 'ERR_SANDBOX_UNAVAILABLE'

/** Host-owned env only. Candidate runtime permissions and host secrets are not inherited. */
export function restrictedValidationEnv(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin',
    TZ: 'UTC',
    LANG: 'C',
    NODE_ENV: 'validation',
  }
}

export function runnerUnavailable(error: { message?: string; stderr?: string; code?: string }): boolean {
  if (error.code === SANDBOX_UNAVAILABLE) return true
  const text = `${error.stderr ?? ''}\n${error.message ?? ''}`
  return /bad option|unknown option|not supported|is not a valid/i.test(text)
}

export function runRestrictedCandidateTests(root: string, testFiles: readonly string[]): string {
  const sandbox = detectOsNetworkSandbox()
  if (sandbox === undefined) {
    const error = new Error('OS network sandbox is not available on this host')
    Object.assign(error, { code: SANDBOX_UNAVAILABLE })
    throw error
  }
  const workspace = existsSync(root) ? realpathSync(root) : path.resolve(root)
  const allowRoot = workspace.endsWith(path.sep) ? workspace : `${workspace}${path.sep}`
  const chunks: string[] = []
  for (const file of testFiles) {
    const nodeArgv = [
      process.execPath,
      '--permission',
      `--allow-fs-read=${allowRoot}`,
      `--allow-fs-write=${allowRoot}`,
      path.join(workspace, file),
    ]
    const wrapped = wrapWithOsNetworkSandbox(sandbox, nodeArgv, workspace)
    chunks.push(execFileSync(wrapped.file, wrapped.args, {
      cwd: workspace,
      encoding: 'utf8',
      timeout: VALIDATION_TEST_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: restrictedValidationEnv(),
    }))
  }
  return chunks.join('\n')
}
