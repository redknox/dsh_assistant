import { SkillContractError, SkillService } from '../domain/skill/index.js'
import { ensureProductHome, resolveProductHome } from '../product/home.js'
import { acquireRuntimeLease, inspectRuntimeLease } from '../product/runtime-lease.js'

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
    const imported = new SkillService(layout.root, 'assistant').importLocal(directory)
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
