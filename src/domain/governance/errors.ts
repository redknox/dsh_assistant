export class GovernanceContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GovernanceContractError'
  }
}

export class GovernanceAuthorityError extends GovernanceContractError {
  constructor(message: string) {
    super(message)
    this.name = 'GovernanceAuthorityError'
  }
}

export class ActivationDeniedError extends GovernanceContractError {
  readonly denials: readonly { reason: string; detail: string }[]

  constructor(denials: readonly { reason: string; detail: string }[]) {
    super(`activation denied: ${denials.map((item) => item.reason).join(', ')}`)
    this.name = 'ActivationDeniedError'
    this.denials = denials
  }
}

export class RollbackDeniedError extends GovernanceContractError {
  readonly denials: readonly { reason: string; detail: string }[]

  constructor(denials: readonly { reason: string; detail: string }[]) {
    super(`rollback denied: ${denials.map((item) => item.reason).join(', ')}`)
    this.name = 'RollbackDeniedError'
    this.denials = denials
  }
}

export class UninstallDeniedError extends GovernanceContractError {
  readonly denials: readonly { reason: string; detail: string }[]

  constructor(denials: readonly { reason: string; detail: string }[]) {
    super(`uninstall denied: ${denials.map((item) => item.reason).join(', ')}`)
    this.name = 'UninstallDeniedError'
    this.denials = denials
  }
}

export class DisableDeniedError extends GovernanceContractError {
  readonly denials: readonly { reason: string; detail: string }[]

  constructor(denials: readonly { reason: string; detail: string }[]) {
    super(`disable denied: ${denials.map((item) => item.reason).join(', ')}`)
    this.name = 'DisableDeniedError'
    this.denials = denials
  }
}
