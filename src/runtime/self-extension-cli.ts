import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { bootAssistantControl, bootSafeModeRuntime } from './boot.js'
import { formatOperatorStatus, operatorStatus } from '../domain/self-extension/status.js'
import { ensureProductHome, resolveProductHome } from '../product/home.js'
import { acquireRuntimeLease, inspectRuntimeLease } from '../product/runtime-lease.js'

function usage(): string {
  return `self-extension <command>
  status | candidates | inspect <id> | diff <id> | request-approval <id>
  approve <id> <fingerprint> | activate <id> | rollback | disable <owner> <version>
  migrate-authoring-contract <id>
  lkg | diagnostics | safe-mode status|enter|exit
  backup <dir> | restore <dir>

Mutating commands fail closed with home-busy when a verified runtime already owns the Home.`
}

const READ_ONLY = new Set(['status', 'candidates', 'inspect', 'diff', 'lkg', 'diagnostics', 'help', ''])

function mutatingSelfExtension(command: string | undefined, action: string | undefined): boolean {
  if (command === 'safe-mode') return action === 'enter' || action === 'exit'
  return command !== undefined && !READ_ONLY.has(command)
}

export async function runSelfExtensionCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command === undefined || command === 'help' || command === '-h') {
    console.log(usage())
    return 0
  }
  const layout = ensureProductHome(resolveProductHome())
  process.env.TARS_NG_HOME = layout.root
  let release = () => {}
  if (mutatingSelfExtension(command, rest[0])) {
    const inspected = await inspectRuntimeLease(layout)
    if (inspected.state === 'held' && inspected.identity.pid !== process.pid) {
      console.error(`home-busy: TARS-NG home is already owned by a verified runtime (pid ${inspected.identity.pid}).`)
      return 1
    }
    if (inspected.state === 'ambiguous') {
      console.error(`home-ambiguous: ${inspected.detail}`)
      return 1
    }
    if (inspected.state !== 'held') {
      const lease = await acquireRuntimeLease(layout)
      if (!lease.ok) {
        console.error(`${lease.error}: ${lease.detail}`)
        return 1
      }
      release = () => {
        lease.hold.release()
      }
    }
  }
  try {
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
      return 0
    }
    if (command === 'candidates') {
      console.log(ctx.candidateWorkspace.list().map((item) => `${item.id} ${item.lifecycle} sealed=${item.sealed}`).join('\n') || '(none)')
      return 0
    }
    if (command === 'inspect') {
      console.log(JSON.stringify(ctx.extensionGovernance.inspectSummary(String(rest[0])), null, 2))
      return 0
    }
    if (command === 'diff') {
      console.log(JSON.stringify(ctx.candidateWorkspace.diff(String(rest[0])), null, 2))
      return 0
    }
    if (command === 'request-approval') {
      console.log(JSON.stringify(ctx.extensionGovernance.requestApproval(String(rest[0])), null, 2))
      return 0
    }
    if (command === 'approve') {
      console.log(JSON.stringify(recoveryRoot.recordApproval(human, {
        candidateId: String(rest[0]),
        fingerprint: String(rest[1]),
        decision: 'approved-for-exact-diff',
      }), null, 2))
      return 0
    }
    if (command === 'activate') {
      console.log(JSON.stringify(await recoveryRoot.activate(String(rest[0]), human), null, 2))
      return 0
    }
    if (command === 'rollback') {
      console.log(JSON.stringify(await recoveryRoot.rollback(human), null, 2))
      return 0
    }
    if (command === 'disable') {
      recoveryRoot.disable(human, String(rest[0]), String(rest[1]))
      console.log(`disabled ${rest[0]}@${rest[1]}`)
      return 0
    }
    if (command === 'migrate-authoring-contract') {
      const migrated = recoveryRoot.migrateAuthoringContract(human, String(rest[0]))
      console.log(JSON.stringify({
        id: migrated.id,
        owner: migrated.owner,
        version: migrated.version,
        contractVersion: migrated.manifest.runtimeContractVersion,
        digest: migrated.digest,
        sealed: migrated.sealed,
        approval: 'NOT APPROVED',
      }, null, 2))
      return 0
    }
    if (command === 'lkg') {
      console.log(JSON.stringify(recoveryRoot.inspect().lastKnownGood ?? null, null, 2))
      return 0
    }
    if (command === 'diagnostics') {
      console.log(JSON.stringify({ boot: diagnostics, activation: recoveryRoot.inspect().lastFailure ?? null }, null, 2))
      return 0
    }
    if (command === 'backup') {
      console.log(JSON.stringify(recoveryRoot.backup(human, String(rest[0])), null, 2))
      return 0
    }
    if (command === 'restore') {
      recoveryRoot.restore(human, String(rest[0]))
      console.log(`restored ${rest[0]}`)
      return 0
    }
    if (command === 'safe-mode') {
      const action = rest[0]
      if (action === 'enter') console.log(JSON.stringify(await recoveryRoot.enterSafeMode(human), null, 2))
      else if (action === 'exit') console.log(JSON.stringify(recoveryRoot.exitSafeMode(human), null, 2))
      else console.log(JSON.stringify({ safeMode: recoveryRoot.inspect().safeMode }, null, 2))
      return 0
    }
    console.error(usage())
    return 1
  } finally {
    await ctx.fiber.dispose()
  }
  } finally {
    release()
  }
}

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invoked) process.exitCode = await runSelfExtensionCli(process.argv.slice(2))
