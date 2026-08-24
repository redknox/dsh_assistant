import { claimSessionPartition, inspectRuntimeContext } from '../../src/product/runtime-context.js'
import { ensureProductHome } from '../../src/product/home.js'
import { writeFileSync } from 'node:fs'

const home = process.env.TARS_CHILD_HOME
const ready = process.env.TARS_CHILD_READY
if (!home || !ready) {
  process.stderr.write('missing TARS_CHILD_HOME or TARS_CHILD_READY\n')
  process.exit(2)
}
const layout = ensureProductHome(home)
const context = inspectRuntimeContext(layout, {}, undefined)
const hold = claimSessionPartition(context)
writeFileSync(ready, `${hold.runId}\n`)
process.exit(0)
