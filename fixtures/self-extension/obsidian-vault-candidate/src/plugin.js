import { createNote, loadNotes, parseNote, searchNotes } from './notes.js'

function textOutput() {
  return {
    schema: { type: 'string' },
    render(_args, value) {
      return [{ type: 'text', text: String(value) }]
    },
  }
}

function configuredVaultRoot() {
  const approved = process.env.DSH_ASSISTANT_OBSIDIAN_VAULT
  if (typeof approved !== 'string' || approved === '') {
    throw new Error('Obsidian vault root is not configured')
  }
  return approved
}

function assertApprovedRoot(requested) {
  const approved = configuredVaultRoot()
  if (requested === undefined || requested === '') return approved
  if (requested !== approved) {
    throw new Error('tool vaultRoot must match the approved vault root')
  }
  return approved
}

function json(value) {
  return JSON.stringify(value)
}

function filesSeam(ctx) {
  return ctx.integrations.hub.files()
}

export const name = 'generated-obsidian-vault'
export const inject = ['tools', 'integrations']

export function apply(ctx) {
  const files = filesSeam(ctx)
  const disposers = [
    ctx.tools.register({
      name: 'obsidian_notes_list',
      description: 'List vault-relative Obsidian notes. Does not read arbitrary files outside the approved vault.',
      parameters: { vaultRoot: { type: 'string' } },
      output: textOutput(),
      async execute(args) {
        const root = assertApprovedRoot(args.vaultRoot)
        return json((await loadNotes(files, root)).map((note) => ({ id: note.id, title: note.title, tags: note.tags })))
      },
    }),
    ctx.tools.register({
      name: 'obsidian_notes_read',
      description: 'Read one vault-relative Obsidian note, including frontmatter, tags, and wikilinks.',
      parameters: { id: { type: 'string', required: true }, vaultRoot: { type: 'string' } },
      output: textOutput(),
      async execute(args) {
        const root = assertApprovedRoot(args.vaultRoot)
        return json(parseNote(String(args.id), await files.readText({ root, path: String(args.id) })))
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
        return json(searchNotes(await loadNotes(files, root), args).map((note) => ({ id: note.id, title: note.title, tags: note.tags })))
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
        return json(await createNote(files, root, {
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
