import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const SEATBELT = `/usr/bin/sandbox-exec`
const UNSHARE = `/usr/bin/unshare`

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

/** Host OS/container boundary that denies network at the process layer, not via Node API patches. */
export function detectOsNetworkSandbox(): OsNetworkSandbox | undefined {
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
