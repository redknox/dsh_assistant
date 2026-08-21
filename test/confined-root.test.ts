import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { ConfinedRootFiles } from '../src/adapters/integrations/confined-root-files.js'
import {
  ConfinedRootError,
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
