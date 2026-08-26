import { SkillContractError, SkillService } from '../domain/skill/index.js'
import { ensureProductHome, resolveProductHome } from '../product/home.js'
import { acquireRuntimeLease, inspectRuntimeLease } from '../product/runtime-lease.js'
import { bootAssistantControl } from './boot.js'

export async function importLocalSkill(directory: string, home?: string): Promise<number> {
  const layout = ensureProductHome(resolveProductHome(home))
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
  try {
    const imported = await new SkillService(layout.root, 'assistant').importLocal(directory)
    console.log(JSON.stringify(imported, null, 2))
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(error instanceof SkillContractError ? `${error.code}: ${message}` : message.split(/\r?\n/, 1)[0] ?? message)
    return 1
  } finally {
    lease.hold.release()
  }
}

export async function runSkillCli(argv: readonly string[], home?: string): Promise<number> {
  const [action, ...rest] = argv
  if (action === 'import-local') return importLocalSkill(String(rest[0] ?? ''), home)
  if (action === undefined || action === 'help' || action === '-h') {
    console.log('skill import-local <directory> | approve <id> <fingerprint> | activate <id> | disable <name> | uninstall <name> | rollback')
    return 0
  }
  const layout = ensureProductHome(resolveProductHome(home))
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
  try {
    const control = await bootAssistantControl({ home: layout.root })
    try {
      const human = control.recoveryRoot.issueAuthority({ kind: 'human-control', source: 'operator-cli' })
      if (action === 'approve') {
        console.log(JSON.stringify(control.recoveryRoot.approveSkill(String(rest[0]), String(rest[1]), human), null, 2))
        return 0
      }
      if (action === 'activate') {
        console.log(JSON.stringify(control.recoveryRoot.activateSkill(String(rest[0]), human), null, 2))
        return 0
      }
      if (action === 'disable') {
        control.recoveryRoot.disableSkill(String(rest[0]), human)
        console.log(`disabled ${rest[0]}`)
        return 0
      }
      if (action === 'uninstall') {
        control.recoveryRoot.uninstallSkill(String(rest[0]), human, rest.slice(1))
        console.log(`uninstalled ${rest[0]}`)
        return 0
      }
      if (action === 'rollback') {
        console.log(JSON.stringify(control.recoveryRoot.rollbackSkill(human), null, 2))
        return 0
      }
      console.error('skill import-local <directory> | approve <id> <fingerprint> | activate <id> | disable <name> | uninstall <name> | rollback')
      return 1
    } finally {
      await control.ctx.fiber.dispose()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message.split(/\r?\n/, 1)[0] ?? message)
    return 1
  } finally {
    lease.hold.release()
  }
}
