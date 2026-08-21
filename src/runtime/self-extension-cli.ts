import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { bootAssistantControl, bootSafeModeRuntime } from './boot.js'
import { formatOperatorStatus, operatorStatus } from '../domain/self-extension/status.js'

function usage(): string {
  return `self-extension <command>
  status | candidates | inspect <id> | diff <id> | request-approval <id>
  approve <id> <fingerprint> | activate <id> | rollback | disable <owner> <version>
  lkg | diagnostics | safe-mode status|enter|exit
  backup <dir> | restore <dir>`
}

export async function runSelfExtensionCli(argv: string[]): Promise<void> {
  const [command, ...rest] = argv
  if (command === undefined || command === 'help' || command === '-h') {
    console.log(usage())
    return
  }
  const safe = command === 'safe-mode' && rest[0] !== 'exit'
  const { ctx, recoveryRoot, diagnostics } = safe && rest[0] === 'enter'
    ? await bootSafeModeRuntime()
    : await bootAssistantControl()
  const human = recoveryRoot.issueAuthority({ kind: 'human-control', source: 'operator-cli' })
  try {
    if (command === 'status') {
      const approvals = new Map(ctx.candidateWorkspace.list().map((item) => [
        item.id,
        ctx.extensionGovernance.inspectApproval(item.id)?.decision ?? 'unreviewed',
      ]))
      const fingerprints = new Map(ctx.candidateWorkspace.list().flatMap((item) => {
        const fingerprint = ctx.extensionGovernance.inspectApproval(item.id)?.fingerprint
        return fingerprint === undefined ? [] : [[item.id, fingerprint] as const]
      }))
      console.log(formatOperatorStatus(operatorStatus({
        activation: recoveryRoot.inspect(),
        registry: [...ctx.capabilityRegistry.list()],
        candidates: [...ctx.candidateWorkspace.list()],
        approvals,
        fingerprints,
        persistence: diagnostics.persistence,
        reasons: diagnostics.reasons,
      })))
      return
    }
    if (command === 'candidates') {
      console.log(ctx.candidateWorkspace.list().map((item) => `${item.id} ${item.lifecycle} sealed=${item.sealed}`).join('\n') || '(none)')
      return
    }
    if (command === 'inspect') {
      console.log(JSON.stringify(ctx.extensionGovernance.inspectSummary(String(rest[0])), null, 2))
      return
    }
    if (command === 'diff') {
      console.log(JSON.stringify(ctx.candidateWorkspace.diff(String(rest[0])), null, 2))
      return
    }
    if (command === 'request-approval') {
      console.log(JSON.stringify(ctx.extensionGovernance.requestApproval(String(rest[0])), null, 2))
      return
    }
    if (command === 'approve') {
      console.log(JSON.stringify(recoveryRoot.recordApproval(human, {
        candidateId: String(rest[0]),
        fingerprint: String(rest[1]),
        decision: 'approved-for-exact-diff',
      }), null, 2))
      return
    }
    if (command === 'activate') {
      console.log(JSON.stringify(await recoveryRoot.activate(String(rest[0]), human), null, 2))
      return
    }
    if (command === 'rollback') {
      console.log(JSON.stringify(await recoveryRoot.rollback(human), null, 2))
      return
    }
    if (command === 'disable') {
      recoveryRoot.disable(human, String(rest[0]), String(rest[1]))
      console.log(`disabled ${rest[0]}@${rest[1]}`)
      return
    }
    if (command === 'lkg') {
      console.log(JSON.stringify(recoveryRoot.inspect().lastKnownGood ?? null, null, 2))
      return
    }
    if (command === 'diagnostics') {
      console.log(JSON.stringify({ boot: diagnostics, activation: recoveryRoot.inspect().lastFailure ?? null }, null, 2))
      return
    }
    if (command === 'backup') {
      console.log(JSON.stringify(recoveryRoot.backup(human, String(rest[0])), null, 2))
      return
    }
    if (command === 'restore') {
      recoveryRoot.restore(human, String(rest[0]))
      console.log(`restored ${rest[0]}`)
      return
    }
    if (command === 'safe-mode') {
      const action = rest[0]
      if (action === 'enter') console.log(JSON.stringify(recoveryRoot.enterSafeMode(human), null, 2))
      else if (action === 'exit') console.log(JSON.stringify(recoveryRoot.exitSafeMode(human), null, 2))
      else console.log(JSON.stringify({ safeMode: recoveryRoot.inspect().safeMode }, null, 2))
      return
    }
    console.error(usage())
    process.exitCode = 1
  } finally {
    await ctx.fiber.dispose()
  }
}

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invoked) await runSelfExtensionCli(process.argv.slice(2))
