import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { detectOsNetworkSandbox, wrapWithOsNetworkSandbox } from '../src/domain/candidate/os-sandbox.js'

describe('OS network sandbox', () => {
  it('wraps node with a process-layer network deny, not a Node API patch list', () => {
    const sandbox = detectOsNetworkSandbox()
    assert.ok(sandbox, 'this host must provide sandbox-exec or unshare --net')
    const workspace = mkdtempSync(path.join(tmpdir(), 'dsh-sandbox-'))
    const wrapped = wrapWithOsNetworkSandbox(sandbox, [process.execPath, '--version'], workspace)
    if (sandbox.kind === 'sandbox-exec') {
      assert.equal(wrapped.file, '/usr/bin/sandbox-exec')
      assert.equal(wrapped.args[0], '-f')
      assert.match(wrapped.args[1] ?? '', /network\.sb$/)
    } else {
      assert.equal(wrapped.file, '/usr/bin/unshare')
      assert.deepEqual(wrapped.args.slice(0, 2), ['--net', '--'])
    }
    assert.ok(wrapped.args.includes(process.execPath))
  })
})
