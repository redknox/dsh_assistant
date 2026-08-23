const VALUE_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object', 'json'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function annotations(node: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {}
  if (typeof node.description === 'string') extra.description = node.description
  if (typeof node.title === 'string') extra.title = node.title
  return extra
}

function valueMatchesType(value: unknown, type: string): boolean {
  if (type === 'string') return typeof value === 'string'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return isRecord(value)
  if (type === 'json') return true
  return false
}

function assertLiterals(node: Record<string, unknown>, type: string, path: string): void {
  if (Array.isArray(node.enum)) {
    if (node.enum.length === 0) throw new Error(`unsupported generated schema enum at ${path}`)
    for (const [index, item] of node.enum.entries()) {
      if (!valueMatchesType(item, type)) {
        throw new Error(`unsupported generated schema enum at ${path}[${index}]`)
      }
    }
  }
  if (Object.hasOwn(node, 'const') && !valueMatchesType(node.const, type)) {
    throw new Error(`unsupported generated schema const at ${path}`)
  }
}

/** Project a supported DSH value schema. Unsupported shapes fail closed. */
export function projectValueSchema(raw: unknown, path = 'schema'): Record<string, unknown> {
  if (!isRecord(raw)) throw new Error(`unsupported generated schema at ${path}`)
  if (Array.isArray(raw.oneOf)) {
    if (raw.oneOf.length < 2) throw new Error(`unsupported generated schema at ${path}.oneOf`)
    return { oneOf: raw.oneOf.map((item, index) => projectValueSchema(item, `${path}.oneOf[${index}]`)), ...annotations(raw) }
  }
  const type = raw.type
  if (typeof type !== 'string' || !VALUE_TYPES.has(type)) {
    throw new Error(`unsupported generated schema type at ${path}`)
  }
  if (type === 'array') {
    return {
      type: 'array',
      ...(raw.items === undefined ? {} : { items: projectValueSchema(raw.items, `${path}.items`) }),
      ...annotations(raw),
    }
  }
  if (type === 'object') {
    const properties = raw.properties === undefined
      ? undefined
      : projectParameterSchema(raw.properties, `${path}.properties`)
    return {
      type: 'object',
      additionalProperties: raw.additionalProperties === false ? false : true,
      ...(properties === undefined ? {} : { properties }),
      ...annotations(raw),
    }
  }
  assertLiterals(raw, type, path)
  const projected: Record<string, unknown> = { type, ...annotations(raw) }
  if (Array.isArray(raw.enum)) projected.enum = raw.enum
  if (Object.hasOwn(raw, 'const')) projected.const = raw.const
  return projected
}

/** Project a DSH implicit parameter map. Every key is a parameter name, including `type`/`properties`. */
export function projectParameterSchema(raw: unknown, path = 'parameters'): Record<string, Record<string, unknown>> {
  if (!isRecord(raw)) throw new Error(`unsupported generated parameters at ${path}`)
  const out: Record<string, Record<string, unknown>> = {}
  for (const [key, spec] of Object.entries(raw)) {
    if (!isRecord(spec)) throw new Error(`unsupported generated parameters at ${path}.${key}`)
    if (typeof spec.type !== 'string' && !Array.isArray(spec.oneOf)) {
      throw new Error(`unsupported generated schema type at ${path}.${key}`)
    }
    const projected = projectValueSchema(spec, `${path}.${key}`)
    out[key] = spec.required === true ? { ...projected, required: true } : projected
  }
  return out
}
