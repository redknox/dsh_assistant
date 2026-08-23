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
    const properties = isRecord(raw.properties) ? projectParameterSchema(raw.properties, `${path}.properties`) : undefined
    return {
      type: 'object',
      additionalProperties: raw.additionalProperties === false ? false : true,
      ...(properties === undefined ? {} : { properties }),
      ...annotations(raw),
    }
  }
  const projected: Record<string, unknown> = { type, ...annotations(raw) }
  if (Array.isArray(raw.enum)) projected.enum = raw.enum
  if (Object.hasOwn(raw, 'const')) projected.const = raw.const
  return projected
}

/** Project an implicit DSH parameter root, preserving required and nested types. */
export function projectParameterSchema(raw: unknown, path = 'parameters'): Record<string, Record<string, unknown>> {
  if (!isRecord(raw)) throw new Error(`unsupported generated parameters at ${path}`)
  const props = isRecord(raw.properties) ? raw.properties : raw
  const out: Record<string, Record<string, unknown>> = {}
  for (const [key, spec] of Object.entries(props)) {
    if (!isRecord(spec) || (typeof spec.type !== 'string' && !Array.isArray(spec.oneOf))) continue
    const projected = projectValueSchema(spec, `${path}.${key}`)
    out[key] = spec.required === true ? { ...projected, required: true } : projected
  }
  return out
}
