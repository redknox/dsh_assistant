import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { bootAssistantControl, bootSafeModeRuntime, type AssistantControl } from './boot.js'
import { importLocalExtension, ImportLocalError } from '../domain/candidate/index.js'
import { formatOperatorStatus, operatorStatus } from '../domain/self-extension/status.js'
import { ensureProductHome, resolveProductHome } from '../product/home.js'
import { acquireRuntimeLease, inspectRuntimeLease } from '../product/runtime-lease.js'

function usage(): string {
  return `self-extension <command>
  status | candidates | inspect <id> | diff <id> | request-approval <id>
  approve <id> <fingerprint> | activate <id> | rollback | disable <owner> <version>
  migrate-authoring-contract <id>
  import-local <directory>
  lkg | diagnostics | safe-mode status|enter|exit
  backup <dir> | restore <dir>

Commands that boot a runtime fail closed with home-busy when a verified runtime already owns the Home.
There is no second offline writer, including status/candidates/inspect.`
}

export interface SelfExtensionCliHooks {
  readonly boot?: (command: string, action: string | undefined) => Promise<AssistantControl>
}

export async function runSelfExtensionCli(argv: string[], hooks: SelfExtensionCliHooks = {}): Promise<number> {
  const [command, ...rest] = argv
  if (command === undefined || command === 'help' || command === '-h') {
    console.log(usage())
    return 0
  }
  const layout = ensureProductHome(resolveProductHome())
  process.env.TARS_NG_HOME = layout.root
  const inspected = await inspectRuntimeLease(layout)
  if (inspected.state === 'held') {
    console.error(`home-busy: TARS-NG home is already owned by a verified runtime (pid ${inspected.identity.pid}).`)
    return 1
  }
  if (inspected.state === 'ambiguous') {
    console.error(`home-ambiguous: ${inspected.detail}`)
    return 1
  }
  const lease = await acquireRuntimeLease(layout)
  if (!lease.ok) {
    console.error(`${lease.error}: ${lease.detail}`)
    return 1
  }
  const release = () => {
    lease.hold.release()
  }
  try {
    const action = rest[0]
    const safe = command === 'safe-mode' && action !== 'exit'
    const { ctx, recoveryRoot, diagnostics } = hooks.boot !== undefined
      ? await hooks.boot(command, action)
      : safe && action === 'enter'
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
      if (command === 'import-local') {
        try {
          const imported = importLocalExtension({
            sourceDir: String(rest[0] ?? ''),
            workspace: ctx.candidateWorkspace,
            workbench: ctx.candidateWorkbench,
            registry: ctx.capabilityRegistry,
          })
          console.log(JSON.stringify(imported, null, 2))
          return 0
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.error(error instanceof ImportLocalError ? `${error.code}: ${message}` : message)
          return 1
        }
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
        if (action === 'enter') console.log(JSON.stringify(await recoveryRoot.enterSafeMode(human), null, 2))
        else if (action === 'exit') console.log(JSON.stringify(recoveryRoot.exitSafeMode(human), null, 2))
        else console.log(JSON.stringify({ safeMode: recoveryRoot.inspect().safeMode }, null, 2))
        return 0
      }
      console.error(usage())
      return 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(error instanceof ImportLocalError ? `${error.code}: ${message}` : message.split(/\r?\n/, 1)[0] ?? message)
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
