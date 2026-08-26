export class SkillContractError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SkillContractError'
    this.code = code
  }
}

export class SkillAuthorityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillAuthorityError'
  }
}
