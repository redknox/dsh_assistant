import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'node:test'

it('keeps the activation adapter independent from product composition', () => {
  const source = readFileSync(join(import.meta.dirname, '../src/adapters/activation/cordis-runtime.ts'), 'utf8')
  assert.doesNotMatch(source, /from ['"]\.\.\/\.\.\/product\//)
})
