import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const root = join(import.meta.dirname, '..')

describe('self-extension contract', () => {
  it('records the governance invariants and both review examples', () => {
    const text = readFileSync(join(root, 'docs/self-extension.md'), 'utf8')
    assert.match(text, /Self-extension without self-authorization/)
    assert.match(text, /Prefer reuse and evolution over capability proliferation/)
    assert.match(text, /What do I have\?/)
    assert.match(text, /What should change\?/)
    assert.match(text, /May I change it\?/)
    assert.match(text, /managed\/\*/)
    assert.match(text, /generated\/\*/)
    assert.match(text, /Capability Resolution Review/)
    assert.match(text, /Capability \+ Permission Diff/)
    assert.match(text, /User Approval/)
    assert.match(text, /Example A — evolve the existing owner/)
    assert.match(text, /Example B — a genuinely new plugin is justified/)
    assert.match(text, /Status: \*\*Designed\*\*/)
    assert.match(text, /no privileged runtime path/i)
  })

  it('does not add a registry, generator, or installer in this issue', () => {
    const forbidden = /capability-registry|plugin-generator|self-extension-loader|autonomous-install/i
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        if (statSync(path).isDirectory()) walk(path)
        else if (path.endsWith('.ts')) files.push(path)
      }
    }
    walk(join(root, 'src'))
    const hits = files.filter((file) => forbidden.test(file) || forbidden.test(readFileSync(file, 'utf8')))
    assert.deepEqual(hits, [])
  })
})
