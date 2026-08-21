import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseNote, renderNote, searchNotes } from '../src/notes.js'

test('parses frontmatter, tags, and wikilinks', () => {
  const note = parseNote('Projects/Alpha.md', `---
title: Alpha
tags:
  - project
---

See [[Alice]] and #inbox
`)
  assert.equal(note.title, 'Alpha')
  assert.deepEqual(note.tags, ['project', 'inbox'])
  assert.deepEqual(note.wikilinks, ['Alice'])
  assert.equal(note.frontmatter.status, undefined)
})

test('renders and searches a note without touching the filesystem', () => {
  const created = parseNote('People/Bob.md', renderNote({
    id: 'People/Bob.md',
    title: 'Bob',
    body: 'Works with Alice.',
    tags: ['person'],
    wikilinks: ['Alice'],
  }))
  assert.equal(created.id, 'People/Bob.md')
  assert.ok(created.content.includes('[[Alice]]'))
  const hits = searchNotes([created], { tag: 'person', text: 'Alice' })
  assert.equal(hits.length, 1)
})
