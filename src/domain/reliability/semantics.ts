import type { RetryPolicy, SideEffectOutcome } from './types.js'

/** Transport failure does not imply the remote side effect did not happen. */
export function interpretTransportFailure(remoteObserved: SideEffectOutcome | 'unknown'): SideEffectOutcome {
  if (remoteObserved === 'applied' || remoteObserved === 'reconciled' || remoteObserved === 'not-applied') return remoteObserved
  return 'unknown'
}

export function mayRetryWrite(policy: RetryPolicy, outcome: SideEffectOutcome): boolean {
  if (outcome === 'not-applied') return policy.writes !== 'blind-on-timeout'
  if (outcome === 'applied' || outcome === 'reconciled') return false
  return false
}
