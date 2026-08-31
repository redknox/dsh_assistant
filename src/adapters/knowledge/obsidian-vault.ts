import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { KnowledgeContractError } from '../../domain/knowledge/normalize.js'
import type { KnowledgeIngestInput } from '../../domain/knowledge/types.js'

const DEFAULT_MAX_NOTES = 10_000
const DEFAULT_MAX_NOTE_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_DEPTH = 24
const MAX_WRITE_CHARS = 64 * 1024

export interface ObsidianVaultScanOptions {
  readonly maxNotes?: number
  readonly maxNoteBytes?: number
  readonly maxDepth?: number
}

export interface ObsidianNoteProposal {
  readonly action: 'create' | 'append'
  readonly path: string
  readonly content: string
  readonly expectedDigest?: string
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

/** Read-only, bounded Vault scan. Hidden folders, symlinks, and non-Markdown files are ignored. */
export function scanObsidianVault(vaultPath: string, options: ObsidianVaultScanOptions = {}): readonly KnowledgeIngestInput[] {
  const requested = path.resolve(vaultPath)
  if (!existsSync(requested) || !statSync(requested).isDirectory()) {
    throw new KnowledgeContractError('Obsidian Vault must be an existing directory')
  }
  if (lstatSync(requested).isSymbolicLink()) throw new KnowledgeContractError('Obsidian Vault root must not be a symlink')
  const root = realpathSync(requested)
  if (!existsSync(path.join(root, '.obsidian'))) throw new KnowledgeContractError('directory is not an Obsidian Vault')
  const maxNotes = options.maxNotes ?? DEFAULT_MAX_NOTES
  const maxNoteBytes = options.maxNoteBytes ?? DEFAULT_MAX_NOTE_BYTES
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const notes: KnowledgeIngestInput[] = []

  const visit = (directory: string, depth: number) => {
    if (depth > maxDepth) throw new KnowledgeContractError(`Obsidian Vault exceeds maximum depth ${maxDepth}`)
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const candidate = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      const resolved = realpathSync(candidate)
      if (!inside(root, resolved)) throw new KnowledgeContractError('Obsidian Vault entry escaped the configured root')
      if (entry.isDirectory()) {
        visit(resolved, depth + 1)
        continue
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') continue
      const size = statSync(resolved).size
      if (size > maxNoteBytes) continue
      if (notes.length >= maxNotes) throw new KnowledgeContractError(`Obsidian Vault exceeds maximum note count ${maxNotes}`)
      const text = readFileSync(resolved, 'utf8').replace(/^\uFEFF/, '')
      if (text.trim() === '' || text.includes('\0')) continue
      notes.push({
        sourceUri: resolved,
        sourceKind: 'note',
        text,
        title: path.basename(entry.name, path.extname(entry.name)),
      })
    }
  }

  visit(root, 0)
  return notes
}

function normalizedNotePath(value: string): string {
  const notePath = value.trim()
  if (notePath === '' || path.isAbsolute(notePath) || notePath.includes('\\')) throw new KnowledgeContractError('Obsidian note path must be Vault-relative')
  const parts = notePath.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new KnowledgeContractError('Obsidian note path contains a forbidden segment')
  }
  if (path.extname(notePath).toLowerCase() !== '.md') throw new KnowledgeContractError('Obsidian note path must end in .md')
  return parts.join('/')
}

function normalizedContent(value: string): string {
  if (value.trim() === '' || value.includes('\0')) throw new KnowledgeContractError('Obsidian note content must be non-empty text')
  if (value.length > MAX_WRITE_CHARS) throw new KnowledgeContractError(`Obsidian note content exceeds ${MAX_WRITE_CHARS} characters`)
  return value.endsWith('\n') ? value : `${value}\n`
}

function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export class ObsidianVaultAccess {
  readonly root: string

  constructor(vaultPath: string, private readonly onWrite?: (input: KnowledgeIngestInput) => void) {
    const requested = path.resolve(vaultPath)
    if (!existsSync(requested) || !statSync(requested).isDirectory() || lstatSync(requested).isSymbolicLink()) {
      throw new KnowledgeContractError('Obsidian Vault must be an existing non-symlink directory')
    }
    this.root = realpathSync(requested)
    if (!existsSync(path.join(this.root, '.obsidian'))) throw new KnowledgeContractError('directory is not an Obsidian Vault')
  }

  proposeCreate(notePath: string, content: string): ObsidianNoteProposal {
    const normalizedPath = normalizedNotePath(notePath)
    const target = this.resolveTarget(normalizedPath, false)
    if (existsSync(target)) throw new KnowledgeContractError('Obsidian note already exists; overwrite is not supported')
    return { action: 'create', path: normalizedPath, content: normalizedContent(content) }
  }

  proposeAppend(notePath: string, content: string): ObsidianNoteProposal {
    const normalizedPath = normalizedNotePath(notePath)
    const target = this.resolveTarget(normalizedPath, true)
    const original = readFileSync(target, 'utf8')
    return { action: 'append', path: normalizedPath, content: normalizedContent(content), expectedDigest: digestOf(original) }
  }

  create(notePath: string, content: string): { readonly action: 'created'; readonly path: string; readonly sourceUri: string } {
    const proposal = this.proposeCreate(notePath, content)
    const target = this.resolveTarget(proposal.path, false)
    this.ensureParents(proposal.path)
    const fd = openSync(target, 'wx', 0o600)
    try {
      writeFileSync(fd, proposal.content, 'utf8')
    } finally {
      closeSync(fd)
    }
    this.refresh(target, proposal.content)
    return { action: 'created', path: proposal.path, sourceUri: target }
  }

  append(notePath: string, content: string, expectedDigest: string): { readonly action: 'appended'; readonly path: string; readonly sourceUri: string } {
    const normalizedPath = normalizedNotePath(notePath)
    const target = this.resolveTarget(normalizedPath, true)
    const original = readFileSync(target, 'utf8')
    if (digestOf(original) !== expectedDigest) throw new KnowledgeContractError('Obsidian note changed since the proposal; request a new approval')
    const addition = normalizedContent(content)
    const next = `${original}${original === '' || original.endsWith('\n') ? '' : '\n'}${addition}`
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
    try {
      writeFileSync(temporary, next, { encoding: 'utf8', mode: statSync(target).mode & 0o777 })
      renameSync(temporary, target)
    } catch (error) {
      try { unlinkSync(temporary) } catch { /* absent or already renamed */ }
      throw error
    }
    this.refresh(target, next)
    return { action: 'appended', path: normalizedPath, sourceUri: target }
  }

  private resolveTarget(notePath: string, mustExist: boolean): string {
    const target = path.resolve(this.root, notePath)
    if (!inside(this.root, target)) throw new KnowledgeContractError('Obsidian note escaped the configured Vault')
    if (mustExist) {
      if (!existsSync(target) || !lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()) throw new KnowledgeContractError('Obsidian note does not exist or is not a regular file')
      const resolved = realpathSync(target)
      if (!inside(this.root, resolved)) throw new KnowledgeContractError('Obsidian note escaped the configured Vault')
      return resolved
    }
    return target
  }

  private ensureParents(notePath: string): void {
    let current = this.root
    for (const segment of notePath.split('/').slice(0, -1)) {
      current = path.join(current, segment)
      if (!existsSync(current)) mkdirSync(current, { mode: 0o700 })
      if (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory() || !inside(this.root, realpathSync(current))) {
        throw new KnowledgeContractError('Obsidian note parent is unsafe')
      }
    }
  }

  private refresh(sourceUri: string, text: string): void {
    this.onWrite?.({ sourceUri, sourceKind: 'note', text, title: path.basename(sourceUri, '.md') })
  }
}
