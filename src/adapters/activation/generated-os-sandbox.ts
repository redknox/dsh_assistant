import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { OsNetworkSandbox } from '../../domain/candidate/os-sandbox.js'

function generatedSeatbelt(nodePath: string): string {
  const allowed = new Set<string>([nodePath])
  try {
    if (existsSync(nodePath)) allowed.add(realpathSync(nodePath))
  } catch {
    /* keep the spawn path even if it is not resolvable */
  }
  const execAllows = [...allowed]
    .map((file) => `(allow process-exec (literal ${JSON.stringify(file)}))`)
    .join('\n')
  return `(version 1)
(allow default)
(deny network*)
(deny network-outbound)
(deny network-inbound)
(deny network-bind)
(deny process-exec)
${execAllows}
`
}

export function wrapGeneratedOsSandbox(
  sandbox: OsNetworkSandbox,
  argv: readonly string[],
  workspace: string,
  nodePath = process.execPath,
): { file: string; args: string[] } {
  if (sandbox.kind === 'sandbox-exec') {
    const dir = path.join(tmpdir(), 'tars-ng-generated-sb')
    mkdirSync(dir, { recursive: true })
    const dest = path.join(dir, `${path.basename(workspace)}.sb`)
    writeFileSync(dest, generatedSeatbelt(nodePath))
    return { file: sandbox.file, args: ['-f', dest, ...argv] }
  }
  return { file: sandbox.file, args: ['--user', '--map-root-user', '--net', '--', ...argv] }
}
