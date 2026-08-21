import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const SEATBELT = `/usr/bin/sandbox-exec`
const UNSHARE = `/usr/bin/unshare`
const PROBE_TIMEOUT_MS = 5_000

const SEATBELT_PROFILE = `(version 1)
(allow default)
(deny network*)
(deny network-outbound)
(deny network-inbound)
(deny network-bind)
`

export type OsNetworkSandbox =
  | { readonly kind: 'sandbox-exec'; readonly file: typeof SEATBELT }
  | { readonly kind: 'unshare'; readonly file: typeof UNSHARE }

let cached: OsNetworkSandbox | null | undefined

function locateOsNetworkSandbox(): OsNetworkSandbox | undefined {
  if (process.platform === 'darwin' && existsSync(SEATBELT)) {
    return { kind: 'sandbox-exec', file: SEATBELT }
  }
  if (process.platform === 'linux' && existsSync(UNSHARE)) {
    return { kind: 'unshare', file: UNSHARE }
  }
  return undefined
}

export function writeSeatbeltProfile(workspace: string): string {
  const dir = path.join(workspace, '.dsh')
  mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, 'network.sb')
  writeFileSync(dest, SEATBELT_PROFILE)
  return dest
}

export function wrapWithOsNetworkSandbox(
  sandbox: OsNetworkSandbox,
  argv: readonly string[],
  workspace: string,
): { file: string; args: string[] } {
  if (sandbox.kind === 'sandbox-exec') {
    return { file: sandbox.file, args: ['-f', writeSeatbeltProfile(workspace), ...argv] }
  }
  return { file: sandbox.file, args: ['--net', '--', ...argv] }
}

export function sandboxStartupUnavailable(error: {
  message?: string
  stdout?: string
  stderr?: string
  code?: string
}): boolean {
  const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`
  if (/AssertionError|# tests|ℹ tests|not ok /i.test(output)) return false
  if (error.code === 'EPERM' || error.code === 'EACCES') return true
  const text = `${error.stderr ?? ''}\n${error.message ?? ''}`
  return /EPERM|failed to unshare|cannot unshare|unshare:|sandbox-exec:|Operation not permitted|sandbox is disabled|policy.disabled/i.test(text)
}

/** Presence is not enough: a sandboxed process must actually start. */
export function probeOsNetworkSandbox(sandbox: OsNetworkSandbox): boolean {
  const scratch = mkdtempSync(path.join(tmpdir(), 'dsh-sandbox-probe-'))
  try {
    const wrapped = wrapWithOsNetworkSandbox(sandbox, [process.execPath, '--version'], scratch)
    execFileSync(wrapped.file, wrapped.args, {
      cwd: scratch,
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', TZ: 'UTC', LANG: 'C', NODE_ENV: 'validation' },
    })
    return true
  } catch {
    return false
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Host OS/container boundary that denies network at the process layer, not via Node API patches. */
export function detectOsNetworkSandbox(): OsNetworkSandbox | undefined {
  if (cached === null) return undefined
  if (cached !== undefined) return cached
  const located = locateOsNetworkSandbox()
  if (located === undefined || !probeOsNetworkSandbox(located)) {
    cached = null
    return undefined
  }
  cached = located
  return located
}

export function resetOsNetworkSandboxCache(): void {
  cached = undefined
}
