import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { SkillContractError } from './errors.js'
import type { SkillInvocationPolicy, SkillProvenance } from './types.js'

export const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const SECRET_KEY = /(secret|password|passwd|api[_-]?key|token|credential|private[_-]?key|authorization)/i
const FORBIDDEN_BASENAMES = new Set([
  'node_modules', 'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'npm-shrinkwrap.json', '.git', 'src', 'scripts', 'bin',
])
const FORBIDDEN_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.node', '.wasm', '.so', '.dylib', '.dll', '.exe', '.py', '.rb', '.php',
])
const ALLOWED_REFERENCE = /\.(md|txt|json|ya?ml)$/i
const ALLOWED_ASSET = /\.(png|jpe?g|gif|svg|webp)$/i
const MAX_FILES = 32
const MAX_FILE_BYTES = 64 * 1024
const MAX_TOTAL_BYTES = 256 * 1024
const MAX_DEPTH = 3

export interface InspectedSkillBundle {
  readonly name: string
  readonly version: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: SkillInvocationPolicy
  readonly resources: readonly string[]
  readonly files: Readonly<Record<string, string>>
  readonly plannedDigest: string
}

export function skillId(name: string, version: string): string {
  return `${name}@${version}`
}

export function digestSkillFiles(files: Readonly<Record<string, string>>): string {
  const hash = createHash('sha256')
  for (const relative of Object.keys(files).sort()) {
    hash.update(relative)
    hash.update('\0')
    hash.update(files[relative] ?? '')
    hash.update('\0')
  }
  return hash.digest('hex')
}

export function inspectSkillDirectory(sourceDir: string, host: {
  readonly version: string
  readonly provenance: SkillProvenance
}): InspectedSkillBundle {
  const root = path.resolve(sourceDir)
  if (!existsSync(root) || !statSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
    throw new SkillContractError('skill-boundary', 'skill import-local requires one source directory')
  }
  const files = collectAllowlistedFiles(root)
  const markdown = files['SKILL.md']
  if (markdown === undefined) throw new SkillContractError('skill-frontmatter', 'SKILL.md is required')
  const parsed = parseSkillMarkdown(markdown)
  if (!isSkillName(parsed.name)) throw new SkillContractError('skill-name', `invalid skill name: ${parsed.name}`)
  if (!STRICT_SEMVER.test(host.version)) throw new SkillContractError('skill-version', `invalid skill version: ${host.version}`)
  if (parsed.body.trim().length < 8) throw new SkillContractError('skill-body', 'instruction body is empty or unbounded')
  if (parsed.body.length > 16 * 1024) throw new SkillContractError('skill-body', 'instruction body exceeds the bounded limit')
  return {
    name: parsed.name,
    version: host.version,
    description: parsed.description,
    whenToUse: parsed.whenToUse,
    invocation: parsed.invocation,
    resources: Object.keys(files).filter((item) => item !== 'SKILL.md').sort(),
    files,
    plannedDigest: digestSkillFiles(files),
  }
}

export function parseSkillMarkdown(text: string): {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: SkillInvocationPolicy
  readonly body: string
} {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (match === null) throw new SkillContractError('skill-frontmatter', 'SKILL.md must start with YAML frontmatter')
  const data = parseSimpleYaml(match[1] ?? '')
  rejectSecrets(data)
  const name = requiredString(data, 'name')
  const description = requiredString(data, 'description')
  if (description.trim().length < 3) throw new SkillContractError('skill-frontmatter', 'description is required')
  if ('version' in data) throw new SkillContractError('skill-authority', 'DSH frontmatter version is not installation authority')
  if ('provenance' in data) throw new SkillContractError('skill-authority', 'DSH frontmatter provenance is not installation authority')
  const whenToUse = optionalString(data, 'whenToUse')
  const modelInvocable = optionalBoolean(data, 'disable-model-invocation') === true ? false : true
  const userInvocable = optionalBoolean(data, 'user-invocable') ?? true
  return {
    name,
    description,
    whenToUse,
    invocation: { modelInvocable, userInvocable },
    body: match[2] ?? '',
  }
}

function collectAllowlistedFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  let total = 0
  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > MAX_DEPTH) throw new SkillContractError('skill-boundary', 'skill bundle exceeds max depth')
    const entries = readdirSync(dir)
    if (new Set(entries.map((item) => item.toLowerCase())).size !== entries.length) {
      throw new SkillContractError('skill-boundary', 'skill bundle contains a case-colliding name')
    }
    for (const entry of entries) {
      if (entry === '.' || entry === '..' || entry === 'tars-ng.skill.json') continue
      const relative = prefix === '' ? entry : `${prefix}/${entry}`
      const full = path.join(dir, entry)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) throw new SkillContractError('skill-boundary', `symlink rejected: ${relative}`)
      if (stat.isDirectory()) {
        if (FORBIDDEN_BASENAMES.has(entry.toLowerCase())) {
          throw new SkillContractError('skill-boundary', `unexpected skill path: ${relative}`)
        }
        if (prefix === '' && entry !== 'references' && entry !== 'assets') {
          throw new SkillContractError('skill-boundary', `file outside the bounded skill allowlist: ${relative}`)
        }
        walk(full, relative, depth + 1)
        continue
      }
      if (!stat.isFile()) throw new SkillContractError('skill-boundary', `non-regular file rejected: ${relative}`)
      if (FORBIDDEN_BASENAMES.has(entry.toLowerCase()) || FORBIDDEN_EXTENSIONS.has(path.extname(entry).toLowerCase())) {
        throw new SkillContractError('skill-boundary', `unexpected skill path: ${relative}`)
      }
      if (!isAllowedRelative(relative)) {
        throw new SkillContractError('skill-boundary', `file outside the bounded skill allowlist: ${relative}`)
      }
      if (stat.size > MAX_FILE_BYTES) throw new SkillContractError('skill-boundary', `skill file exceeds size bound: ${relative}`)
      total += stat.size
      if (Object.keys(files).length >= MAX_FILES || total > MAX_TOTAL_BYTES) {
        throw new SkillContractError('skill-boundary', 'skill bundle exceeds size or file-count bound')
      }
      files[relative] = readFileSync(full, 'utf8')
    }
  }
  walk(root, '', 0)
  return files
}

function isAllowedRelative(relative: string): boolean {
  if (relative.includes('..') || path.isAbsolute(relative) || relative.includes('\\')) return false
  if (relative === 'SKILL.md') return true
  if (relative.startsWith('references/') && ALLOWED_REFERENCE.test(relative)) return true
  if (relative.startsWith('assets/') && ALLOWED_ASSET.test(relative)) return true
  return false
}

function parseSimpleYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx <= 0) throw new SkillContractError('skill-frontmatter', `malformed frontmatter line: ${line}`)
    const key = line.slice(0, idx).trim()
    let value: unknown = line.slice(idx + 1).trim()
    if (value === 'true') value = true
    else if (value === 'false') value = false
    else if (typeof value === 'string' && (value.startsWith('"') || value.startsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

function requiredString(data: Record<string, unknown>, key: string): string {
  const value = data[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SkillContractError('skill-frontmatter', `${key} is required`)
  }
  return value.trim()
}

function optionalString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new SkillContractError('skill-frontmatter', `${key} must be a string`)
  return value
}

function optionalBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  const value = data[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new SkillContractError('skill-frontmatter', `${key} must be a boolean`)
  return value
}

function rejectSecrets(data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (SECRET_KEY.test(key) || (typeof value === 'string' && SECRET_KEY.test(value) && key === 'metadata')) {
      throw new SkillContractError('skill-secret', 'skill frontmatter must not carry secrets')
    }
    if (key === 'metadata' && value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
      throw new SkillContractError('skill-frontmatter', 'metadata must be a bounded object')
    }
  }
}
