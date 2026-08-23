export class WorkbenchContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkbenchContractError'
  }
}

/** Copy failed and host cleanup could not finish; leftover child is still authoritative. */
export class WorkbenchRepairRollbackError extends WorkbenchContractError {
  constructor(
    message: string,
    readonly causeError: unknown,
    readonly rollbackError: unknown,
    readonly leftoverCandidateId: string,
  ) {
    super(message)
    this.name = 'WorkbenchRepairRollbackError'
  }
}
