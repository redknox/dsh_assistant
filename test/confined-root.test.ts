import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { ConfinedRootFiles } from '../src/adapters/integrations/confined-root-files.js'
import {
  ConfinedRootError,
  SANDBOX_MAX_LIST_DEPTH,
  SANDBOX_MAX_LIST_ENTRIES,
  SANDBOX_MAX_TRAVERSAL_ENTRIES,
  deleteConfinedText,
  listConfinedTextFiles,
  readConfinedText,
  writeConfinedText,
} from '../src/domain/files/confined-root.js'

function vaultWithOutsideLink() {
  const vault = mkdtempSync(path.join(tmpdir(), 'confined-vault-'))
  const outside = mkdtempSync(path.join(tmpdir(), 'confined-outside-'))
  mkdirSync(path.join(vault, 'Projects'))
  writeFileSync(path.join(vault, 'Projects', 'Alpha.md'), 'inside\n')
  writeFileSync(path.join(outside, 'secret.md'), 'leaked\n')
  symlinkSync(outside, path.join(vault, 'link'))
  return { vault, outside }
}

describe('confined-root files seam', () => {
  it('lists and reads only through real-path containment', () => {
    const { vault } = vaultWithOutsideLink()
    assert.deepEqual(listConfinedTextFiles(vault), ['Projects/Alpha.md'])
    assert.equal(readConfinedText(vault, 'Projects/Alpha.md'), 'inside\n')
  })

  it('does not follow a vault-local symlink directory to an outside file', () => {
    const { vault } = vaultWithOutsideLink()
    assert.throws(() => readConfinedText(vault, 'link/secret.md'), ConfinedRootError)
    assert.throws(() => writeConfinedText(vault, 'link/nested.md', 'nope'), ConfinedRootError)
    assert.doesNotMatch(listConfinedTextFiles(vault).join('\n'), /secret/)
  })

  it('rejects create when the nearest existing parent is a symlink escape', () => {
    const { vault } = vaultWithOutsideLink()
    assert.throws(() => writeConfinedText(vault, 'link/deeper/new.md', 'nope'), ConfinedRootError)
  })

  it('creates only after the existing parent resolves inside the root', () => {
    const vault = mkdtempSync(path.join(tmpdir(), 'confined-write-'))
    writeConfinedText(vault, 'People/Bob.md', 'ok\n')
    assert.equal(readConfinedText(vault, 'People/Bob.md'), 'ok\n')
  })

  it('lists every regular file when the extension filter is empty', () => {
    const vault = mkdtempSync(path.join(tmpdir(), 'confined-all-'))
    writeFileSync(path.join(vault, 'note.md'), 'md\n')
    writeFileSync(path.join(vault, 'readme.txt'), 'txt\n')
    assert.deepEqual(listConfinedTextFiles(vault, '', ''), ['note.md', 'readme.txt'])
  })

  it('deletes only a real file inside the root', () => {
    const vault = mkdtempSync(path.join(tmpdir(), 'confined-del-'))
    writeConfinedText(vault, 'note.md', 'bye\n')
    deleteConfinedText(vault, 'note.md')
    assert.deepEqual(listConfinedTextFiles(vault), [])
    assert.throws(() => deleteConfinedText(vault, 'note.md'), ConfinedRootError)
    assert.throws(() => deleteConfinedText(vault, '../outside.md'), ConfinedRootError)
  })

  it('fails listing when the entry or depth bound is crossed during the walk', () => {
    const vault = mkdtempSync(path.join(tmpdir(), 'confined-bound-'))
    for (let i = 0; i < SANDBOX_MAX_LIST_ENTRIES + 1; i += 1) writeFileSync(path.join(vault, `n${i}.md`), 'ok\n')
    assert.throws(() => listConfinedTextFiles(vault), /traversal bound|entry bound/)
    const deep = mkdtempSync(path.join(tmpdir(), 'confined-depth-'))
    let current = deep
    for (let i = 0; i < SANDBOX_MAX_LIST_DEPTH + 1; i += 1) {
      current = path.join(current, `d${i}`)
      mkdirSync(current)
    }
    writeFileSync(path.join(current, 'leaf.md'), 'ok\n')
    assert.throws(() => listConfinedTextFiles(deep), /depth bound/)
  })

  it('counts non-matching files and empty directories against the traversal bound', () => {
    const extras = mkdtempSync(path.join(tmpdir(), 'confined-nomatch-'))
    for (let i = 0; i < SANDBOX_MAX_TRAVERSAL_ENTRIES + 1; i += 1) {
      writeFileSync(path.join(extras, `n${i}.txt`), 'ok\n')
    }
    assert.throws(() => listConfinedTextFiles(extras, '', '.md'), /traversal bound/)
    const empty = mkdtempSync(path.join(tmpdir(), 'confined-emptydir-'))
    for (let i = 0; i < SANDBOX_MAX_TRAVERSAL_ENTRIES + 1; i += 1) {
      mkdirSync(path.join(empty, `d${i}`))
    }
    assert.throws(() => listConfinedTextFiles(empty), /traversal bound/)
  })

  it('records confined access on the public files adapter', async () => {
    const vault = mkdtempSync(path.join(tmpdir(), 'confined-log-'))
    writeFileSync(path.join(vault, 'note.md'), 'hi\n')
    const files = new ConfinedRootFiles()
    await files.readText({ root: vault, path: 'note.md' })
    await files.listTextFiles({ root: vault })
    assert.ok(files.confinedAccesses().some((item) => item.op === 'read' && item.path === 'note.md'))
    assert.ok(files.confinedAccesses().some((item) => item.op === 'list'))
  })
})
