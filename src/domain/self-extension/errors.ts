export class PersistenceIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PersistenceIntegrityError'
  }
}

export class PersistenceSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PersistenceSchemaError'
  }
}
