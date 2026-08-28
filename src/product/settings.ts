import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { SettingsFieldKind, SettingsFieldView, SettingsGroup, SettingsSnapshot, SettingsUpdate } from './settings-types.js'

type Definition = {
  readonly id: string
  readonly label: string
  readonly group: SettingsGroup
  readonly kind: SettingsFieldKind
  readonly description: string
  readonly options?: readonly { readonly value: string; readonly label: string }[]
  readonly validate?: (value: string) => boolean
}

const DEFINITIONS: readonly Definition[] = [
  { id: 'DEEPSEEK_API_KEY', label: 'DeepSeek API key', group: 'AI', kind: 'secret', description: 'Required for the primary model route.' },
  { id: 'DSH_ASSISTANT_FEISHU_MODE', label: 'Mail & Contacts', group: 'Feishu', kind: 'select', description: 'Use the authorized lark-cli user profile.', options: modes('cli') },
  { id: 'DSH_ASSISTANT_FEISHU_CALENDAR_MODE', label: 'Feishu Calendar', group: 'Feishu', kind: 'select', description: 'Use Feishu Calendar and meeting-note permissions.', options: modes('cli') },
  { id: 'DSH_ASSISTANT_FEISHU_PROFILE', label: 'lark-cli profile', group: 'Feishu', kind: 'text', description: 'Local lark-cli profile name; credentials remain outside TARS-NG.', validate: boundedName },
  { id: 'DSH_ASSISTANT_GOOGLE_CALENDAR_MODE', label: 'Google Calendar', group: 'Calendar', kind: 'select', description: 'Enable the Google Calendar v3 provider.', options: modes('live') },
  { id: 'DSH_ASSISTANT_GOOGLE_CALENDAR_ACCESS_TOKEN', label: 'Google access token', group: 'Calendar', kind: 'secret', description: 'OAuth access token. TARS-NG never displays the stored value.' },
  { id: 'DSH_ASSISTANT_KNOWLEDGE_OBSIDIAN_VAULT', label: 'Obsidian vault', group: 'Knowledge', kind: 'path', description: 'Dedicated assistant Vault root. Read and governed append/create only.', validate: absolutePath },
  { id: 'DSH_ASSISTANT_SANDBOX_ROOT', label: 'Files & Tasks workspace', group: 'Workspace', kind: 'path', description: 'Existing non-symlink directory confining Files and Tasks.', validate: absolutePath },
] as const

const IDS = new Set(DEFINITIONS.map((item) => item.id))

/** Governed editor for the Home env file. Its Interface never returns secret values. */
export class ProductSettings {
  constructor(private readonly envFile: string, private readonly env: NodeJS.ProcessEnv = process.env) {}

  inspect(): SettingsSnapshot {
    const contents = this.contents()
    const home = parseEnv(contents)
    return {
      revision: revisionOf(contents),
      fields: DEFINITIONS.map((definition) => fieldView(definition, home, this.env)),
      restartRequired: false,
      envFileReady: !existsSync(this.envFile) || ((statSync(this.envFile).mode & 0o077) === 0),
    }
  }

  update(input: SettingsUpdate): SettingsSnapshot {
    const contents = this.contents()
    if (input.revision !== revisionOf(contents)) throw new Error('stale-settings')
    if (!Array.isArray(input.changes) || input.changes.length === 0) throw new Error('empty-settings-change')
    const home = parseEnv(contents)
    const changes = new Map<string, string | undefined>()
    for (const change of input.changes) {
      if (!IDS.has(change.id) || changes.has(change.id)) throw new Error('invalid-settings-field')
      if (home[change.id] === undefined && this.env[change.id]) throw new Error('externally-managed-setting')
      if (change.clear === true) {
        changes.set(change.id, undefined)
        continue
      }
      if (typeof change.value !== 'string') throw new Error('invalid-settings-value')
      changes.set(change.id, validateValue(change.id, change.value))
    }
    this.write(rewriteEnv(contents, changes))
    return { ...this.inspect(), restartRequired: true }
  }

  private contents(): string {
    return existsSync(this.envFile) ? readFileSync(this.envFile, 'utf8') : ''
  }

  private write(contents: string): void {
    mkdirSync(path.dirname(this.envFile), { recursive: true, mode: 0o700 })
    const temp = `${this.envFile}.${process.pid}.tmp`
    const fd = openSync(temp, 'w', 0o600)
    try {
      writeSync(fd, contents)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    chmodSync(temp, 0o600)
    renameSync(temp, this.envFile)
    chmodSync(this.envFile, 0o600)
  }
}

function modes(enabled: string) {
  return [{ value: '', label: 'Off' }, { value: enabled, label: 'On' }] as const
}

function boundedName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
}

function absolutePath(value: string): boolean {
  return path.isAbsolute(value) && value.length <= 2_048
}

function validateValue(id: string, raw: string): string {
  if (raw.length > 8_192 || /[\r\n\0]/.test(raw)) throw new Error('invalid-settings-value')
  const definition = DEFINITIONS.find((item) => item.id === id)!
  const value = raw.trim()
  if (value === '') throw new Error('invalid-settings-value')
  if (definition.options && !definition.options.some((item) => item.value === value)) throw new Error('invalid-settings-value')
  if (definition.validate && !definition.validate(value)) throw new Error('invalid-settings-value')
  return value
}

function fieldView(definition: Definition, home: Readonly<Record<string, string>>, env: NodeJS.ProcessEnv): SettingsFieldView {
  const homeValue = home[definition.id]
  const environmentValue = env[definition.id]
  const source = homeValue !== undefined ? 'home' : environmentValue ? 'environment' : 'none'
  const value = homeValue ?? environmentValue
  return {
    id: definition.id,
    label: definition.label,
    group: definition.group,
    kind: definition.kind,
    description: definition.description,
    present: Boolean(value),
    source,
    editable: source !== 'environment',
    ...(definition.kind !== 'secret' && value !== undefined ? { value } : {}),
    ...(definition.options ? { options: definition.options } : {}),
  }
}

function parseEnv(contents: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue
    let value = match[2] ?? ''
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    out[match[1]!] = value
  }
  return out
}

function rewriteEnv(contents: string, changes: ReadonlyMap<string, string | undefined>): string {
  const remaining = new Map(changes)
  const lines: string[] = []
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/)
    const id = match?.[1]
    if (!id || !remaining.has(id)) {
      if (line !== '' || lines.length > 0) lines.push(line)
      continue
    }
    const value = remaining.get(id)
    remaining.delete(id)
    if (value !== undefined) lines.push(`${id}=${value}`)
  }
  while (lines.at(-1) === '') lines.pop()
  for (const [id, value] of remaining) if (value !== undefined) lines.push(`${id}=${value}`)
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

function revisionOf(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}
