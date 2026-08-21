import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNote, loadNotes, parseNote, searchNotes } from './notes.js'
import { readVaultFile, VaultEscapeError } from './vault.js'

function textOutput() {
  return {
    schema: { type: 'string' },
    render(_args, value) {
      return [{ type: 'text', text: String(value) }]
    },
  }
}

function approvedRoot() {
  if (process.env.DSH_ASSISTANT_OBSIDIAN_VAULT) return process.env.DSH_ASSISTANT_OBSIDIAN_VAULT
  const config = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vault.json')
  if (!existsSync(config)) throw new Error('Obsidian vault root is not configured')
  return JSON.parse(readFileSync(config, 'utf8')).vaultRoot
}

function assertApprovedRoot(requested) {
  const approved = path.resolve(approvedRoot())
  if (requested === undefined || requested === '') return approved
  if (path.resolve(requested) !== approved) {
    throw new VaultEscapeError('tool vaultRoot must match the approved vault root')
  }
  return approved
}

function json(value) {
  return JSON.stringify(value)
}

export const name = 'generated-obsidian-vault'
export const inject = ['tools']

export function apply(ctx) {
  const disposers = [
    ctx.tools.register({
      name: 'obsidian_notes_list',
      description: 'List vault-relative Obsidian notes. Does not read arbitrary files outside the approved vault.',
      parameters: { vaultRoot: { type: 'string' } },
      output: textOutput(),
      async execute(args) {
        const root = assertApprovedRoot(args.vaultRoot)
        return json(loadNotes(root).map((note) => ({ id: note.id, title: note.title, tags: note.tags })))
      },
    }),
    ctx.tools.register({
      name: 'obsidian_notes_read',
      description: 'Read one vault-relative Obsidian note, including frontmatter, tags, and wikilinks.',
      parameters: { id: { type: 'string', required: true }, vaultRoot: { type: 'string' } },
      output: textOutput(),
      async execute(args) {
        const root = assertApprovedRoot(args.vaultRoot)
        return json(parseNote(String(args.id), readVaultFile(root, String(args.id))))
      },
    }),
    ctx.tools.register({
      name: 'obsidian_notes_search',
      description: 'Search Obsidian notes by path, text, tag, or frontmatter field inside the approved vault.',
      parameters: {
        path: { type: 'string' },
        text: { type: 'string' },
        tag: { type: 'string' },
        frontmatterField: { type: 'string' },
        frontmatterValue: { type: 'string' },
        vaultRoot: { type: 'string' },
      },
      output: textOutput(),
      async execute(args) {
        const root = assertApprovedRoot(args.vaultRoot)
        return json(searchNotes(loadNotes(root), args).map((note) => ({ id: note.id, title: note.title, tags: note.tags })))
      },
    }),
    ctx.tools.register({
      name: 'obsidian_notes_create',
      description: 'Create a Markdown note that preserves Obsidian frontmatter, tags, and wikilinks. Confined to the approved vault.',
      parameters: {
        id: { type: 'string', required: true },
        title: { type: 'string', required: true },
        body: { type: 'string' },
        tags: { type: 'string' },
        wikilinks: { type: 'string' },
        vaultRoot: { type: 'string' },
      },
      output: textOutput(),
      async execute(args) {
        const root = assertApprovedRoot(args.vaultRoot)
        const tags = args.tags === undefined || args.tags === '' ? [] : String(args.tags).split(',').map((item) => item.trim()).filter(Boolean)
        const wikilinks = args.wikilinks === undefined || args.wikilinks === ''
          ? []
          : String(args.wikilinks).split(',').map((item) => item.trim()).filter(Boolean)
        return json(createNote(root, {
          id: String(args.id),
          title: String(args.title),
          body: args.body === undefined ? '' : String(args.body),
          tags,
          wikilinks,
        }))
      },
    }),
  ]
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
  })
}
