import type { RecoveryRoot } from '../governance/root.js'
import type { DurableSelfExtension } from './durable.js'

export interface ReconstructionResult {
  readonly diagnostics: readonly string[]
  readonly safeMode: boolean
  readonly recoveryRequired: boolean
}

export async function reconstructCommittedExtensions(
  root: RecoveryRoot,
  durable?: DurableSelfExtension,
): Promise<ReconstructionResult> {
  if (durable === undefined) {
    return { diagnostics: [], safeMode: root.inspect().safeMode, recoveryRequired: false }
  }
  root.completeInterruptedActivation()
  await root.completeInterruptedRollback()
  const mountDiagnostics = await root.remountCommittedGenerated()
  for (const item of mountDiagnostics) durable.authority.appendDiagnostic(item)
  const status = root.inspect()
  return {
    diagnostics: [...durable.authority.snapshot().recovery.diagnostics],
    safeMode: status.safeMode,
    recoveryRequired: status.recoveryRequired || status.safeMode || status.state === 'activation-failed' || status.state === 'rollback-pending',
  }
}
