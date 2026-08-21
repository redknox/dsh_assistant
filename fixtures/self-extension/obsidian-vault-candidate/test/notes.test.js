import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createNote, parseNote, searchNotes } from '../src/notes.js'
import { VaultEscapeError, writeVaultFile } from '../src/vault.js'

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

test('creates and searches a note inside a confined vault', () => {
  const vault = mkdtempSync(path.join(tmpdir(), 'obsidian-cand-'))
  const created = createNote(vault, {
    id: 'People/Bob.md',
    title: 'Bob',
    body: 'Works with Alice.',
    tags: ['person'],
    wikilinks: ['Alice'],
  })
  assert.equal(created.id, 'People/Bob.md')
  assert.ok(created.content.includes('[[Alice]]'))
  const hits = searchNotes([created], { tag: 'person', text: 'Alice' })
  assert.equal(hits.length, 1)
})

test('rejects vault escape attempts', () => {
  const vault = mkdtempSync(path.join(tmpdir(), 'obsidian-esc-'))
  assert.throws(() => writeVaultFile(vault, '../outside.md', 'nope'), VaultEscapeError)
  assert.throws(() => writeVaultFile(vault, '/tmp/secret.md', 'nope'), VaultEscapeError)
})
