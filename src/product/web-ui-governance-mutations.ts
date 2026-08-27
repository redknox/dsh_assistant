import type { ActivationStatus } from '../domain/governance/types.js'

export type WebUiMutationKind = 'activation' | 'uninstall' | 'recovery'
export type WebUiMutationInFlight = WebUiMutationKind | 'disable'

export class WebUiGovernanceMutations {
  private readonly local: Record<WebUiMutationKind, number> = {
    activation: 0,
    uninstall: 0,
    recovery: 0,
  }

  constructor(private readonly inspect: () => Pick<ActivationStatus, 'lifecycleBusy' | 'state'>) {}

  inFlight(): WebUiMutationInFlight | undefined {
    if (this.local.uninstall > 0) return 'uninstall'
    if (this.local.activation > 0) return 'activation'
    if (this.local.recovery > 0) return 'recovery'
    const inspected = this.inspect()
    if (inspected.lifecycleBusy !== undefined) return inspected.lifecycleBusy
    if (inspected.state === 'activating' || inspected.state === 'activation-pending') return 'activation'
    if (inspected.state === 'rollback-pending') return 'recovery'
    return undefined
  }

  async run<T>(kind: WebUiMutationKind, work: () => T | Promise<T>): Promise<T> {
    this.local[kind] += 1
    try {
      return await work()
    } finally {
      this.local[kind] -= 1
    }
  }
}
