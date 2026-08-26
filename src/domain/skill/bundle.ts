import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { SkillContractError } from './errors.js'
import type { SkillInvocationPolicy } from './types.js'

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

export function readAllowlistedSkillFiles(sourceDir: string): Record<string, string> {
  const root = path.resolve(sourceDir)
  if (!existsSync(root) || !statSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
    throw new SkillContractError('skill-boundary', 'skill import-local requires one source directory')
  }
  const files = collectAllowlistedFiles(root)
  if (files['SKILL.md'] === undefined) throw new SkillContractError('skill-frontmatter', 'SKILL.md is required')
  rejectSecretFrontmatterKeys(files['SKILL.md'])
  if (/\nversion\s*:/i.test(files['SKILL.md']) || /\nprovenance\s*:/i.test(files['SKILL.md'])) {
    throw new SkillContractError('skill-authority', 'DSH frontmatter is not installation authority')
  }
  return files
}

export function applyHostSkillLimits(input: {
  readonly name: string
  readonly description: string
  readonly content: string
  readonly metadata?: Readonly<Record<string, unknown>>
}): void {
  if (!isSkillName(input.name)) throw new SkillContractError('skill-name', `invalid skill name: ${input.name}`)
  if (input.description.trim().length < 3) throw new SkillContractError('skill-frontmatter', 'description is required')
  if (input.content.trim().length < 8) throw new SkillContractError('skill-body', 'instruction body is empty or unbounded')
  if (input.content.length > 16 * 1024) throw new SkillContractError('skill-body', 'instruction body exceeds the bounded limit')
  rejectSecretMetadata(input.metadata)
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

function rejectSecretFrontmatterKeys(markdown: string): void {
  const block = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (block === null) throw new SkillContractError('skill-frontmatter', 'SKILL.md must start with YAML frontmatter')
  for (const raw of (block[1] ?? '').split(/\r?\n/)) {
    const key = raw.split(':', 1)[0]?.trim()
    if (key !== undefined && SECRET_KEY.test(key)) {
      throw new SkillContractError('skill-secret', 'skill frontmatter must not carry secrets')
    }
  }
}

function rejectSecretMetadata(metadata?: Readonly<Record<string, unknown>>): void {
  if (metadata === undefined) return
  for (const key of Object.keys(metadata)) {
    if (SECRET_KEY.test(key)) throw new SkillContractError('skill-secret', 'skill frontmatter must not carry secrets')
  }
}
