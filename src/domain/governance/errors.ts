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
