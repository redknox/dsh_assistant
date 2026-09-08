import { loadNotes, parseNote, renderNote, searchNotes } from './notes.js'

function textOutput() {
  return {
    schema: { type: 'string' },
    render(_args, value) { return [{ type: 'text', text: String(value) }] },
  }
}

function json(value) { return JSON.stringify(value) }

function brokerFiles(ctx) {
  return {
    async listTextFiles() {
      const result = await ctx.broker.request('host.obsidian.read', { operation: 'list' })
      return result.items
    },
    async readText(input) {
      const result = await ctx.broker.request('host.obsidian.read', { operation: 'read', path: input.path })
      return result.text
    },
  }
}

export const name = 'generated-obsidian-vault'

export function apply(ctx) {
  const files = brokerFiles(ctx)
  const disposers = [
    ctx.tools.register({
      name: 'obsidian_notes_list',
      description: 'List notes in the configured Obsidian Vault through the approved host Broker.',
      parameters: {}, output: textOutput(),
      async execute() { return json((await loadNotes(files, '')).map((note) => ({ id: note.id, title: note.title, tags: note.tags }))) },
    }),
    ctx.tools.register({
      name: 'obsidian_notes_read',
      description: 'Read one Vault-relative Obsidian note through the approved host Broker.',
      parameters: { id: { type: 'string', required: true } }, output: textOutput(),
      async execute(args) { return json(parseNote(String(args.id), await files.readText({ path: String(args.id) }))) },
    }),
    ctx.tools.register({
      name: 'obsidian_notes_search',
      description: 'Search parsed Obsidian notes inside the configured Vault.',
      parameters: { path: { type: 'string' }, text: { type: 'string' }, tag: { type: 'string' }, frontmatterField: { type: 'string' }, frontmatterValue: { type: 'string' } },
      output: textOutput(),
      async execute(args) { return json(searchNotes(await loadNotes(files, ''), args).map((note) => ({ id: note.id, title: note.title, tags: note.tags }))) },
    }),
    ctx.tools.register({
      name: 'obsidian_notes_create',
      description: 'Request one governed Obsidian note creation. Returns a pending confirmation until the user approves.',
      parameters: { id: { type: 'string', required: true }, title: { type: 'string', required: true }, body: { type: 'string' }, tags: { type: 'string' }, wikilinks: { type: 'string' } },
      output: textOutput(),
      async execute(args) {
        const id = String(args.id).endsWith('.md') ? String(args.id) : `${String(args.id)}.md`
        const tags = args.tags === undefined || args.tags === '' ? [] : String(args.tags).split(',').map((item) => item.trim()).filter(Boolean)
        const wikilinks = args.wikilinks === undefined || args.wikilinks === '' ? [] : String(args.wikilinks).split(',').map((item) => item.trim()).filter(Boolean)
        const content = renderNote({ id, title: String(args.title), body: args.body === undefined ? '' : String(args.body), tags, wikilinks })
        return json(await ctx.broker.request('host.obsidian.mutate', { operation: 'create', path: id, content }))
      },
    }),
  ]
  ctx.effect(() => () => { for (const dispose of disposers.reverse()) dispose() })
}
