const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g
const HASH_TAG = /(?:^|[\s])#([A-Za-z0-9_/-]+)/g

function parseScalar(raw) {
  const value = raw.trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

export function parseFrontmatter(text) {
  const match = FRONTMATTER.exec(text)
  if (!match) return { frontmatter: {}, body: text }
  const frontmatter = {}
  let currentList
  for (const line of match[1].split('\n')) {
    const list = /^\s*-\s+(.+)$/.exec(line)
    if (list && currentList) {
      frontmatter[currentList].push(parseScalar(list[1]))
      continue
    }
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!pair) continue
    currentList = undefined
    if (pair[2] === '') {
      frontmatter[pair[1]] = []
      currentList = pair[1]
    } else {
      frontmatter[pair[1]] = parseScalar(pair[2])
    }
  }
  return { frontmatter, body: text.slice(match[0].length) }
}

export function parseTags(text, frontmatter = {}) {
  const fromMatter = Array.isArray(frontmatter.tags)
    ? frontmatter.tags.map(String)
    : typeof frontmatter.tags === 'string'
      ? [frontmatter.tags]
      : []
  const fromBody = [...text.matchAll(HASH_TAG)].map((item) => item[1])
  return [...new Set([...fromMatter, ...fromBody])]
}

export function parseWikilinks(text) {
  return [...text.matchAll(WIKILINK)].map((item) => item[1].trim().replaceAll('\\', '/'))
}

export function parseNote(id, text) {
  const { frontmatter, body } = parseFrontmatter(text)
  const basename = id.split('/').pop()?.replace(/\.md$/, '') ?? id
  return {
    id,
    basename,
    title: typeof frontmatter.title === 'string' ? frontmatter.title : basename,
    content: text,
    body,
    frontmatter,
    tags: parseTags(text, frontmatter),
    wikilinks: parseWikilinks(text),
  }
}

export function renderNote(input) {
  const tags = input.tags ?? []
  const links = (input.wikilinks ?? []).map((target) => `[[${target}]]`).join(' ')
  const matter = [
    '---',
    `title: ${input.title}`,
    'tags:',
    ...tags.map((tag) => `  - ${tag}`),
    '---',
    '',
    `# ${input.title}`,
    '',
    input.body ?? '',
    links === '' ? '' : `\n${links}\n`,
  ]
  return matter.join('\n')
}

export async function loadNotes(files, vaultRoot) {
  const ids = await files.listTextFiles({ root: vaultRoot })
  return Promise.all(ids.map(async (id) => parseNote(id, await files.readText({ root: vaultRoot, path: id }))))
}

export function searchNotes(notes, query = {}) {
  return notes.filter((note) => {
    if (query.path && !note.id.toLowerCase().includes(String(query.path).toLowerCase())) return false
    if (query.text && !note.content.toLowerCase().includes(String(query.text).toLowerCase())) return false
    if (query.tag && !note.tags.includes(String(query.tag).replace(/^#/, ''))) return false
    if (query.frontmatterField) {
      const value = note.frontmatter[query.frontmatterField]
      if (query.frontmatterValue === undefined) return value !== undefined
      return String(value) === String(query.frontmatterValue)
    }
    return true
  })
}

export async function createNote(files, vaultRoot, input) {
  const relative = input.id.endsWith('.md') ? input.id : `${input.id}.md`
  const content = renderNote(input)
  await files.writeText({ root: vaultRoot, path: relative, content })
  return parseNote(relative, content)
}
