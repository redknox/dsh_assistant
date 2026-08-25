export class CandidateContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CandidateContractError'
  }
}

export class WorkspaceEscapeError extends CandidateContractError {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceEscapeError'
  }
}

export class SealedCandidateError extends CandidateContractError {
  constructor(message: string) {
    super(message)
    this.name = 'SealedCandidateError'
  }
}

export class ValidationPolicyError extends CandidateContractError {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationPolicyError'
  }
}

export class ImportLocalError extends CandidateContractError {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ImportLocalError'
    this.code = code
  }
}
