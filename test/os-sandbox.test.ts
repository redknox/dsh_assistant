import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  detectOsNetworkSandbox,
  probeOsNetworkSandbox,
  sandboxStartupUnavailable,
  wrapWithOsNetworkSandbox,
} from '../src/domain/candidate/os-sandbox.js'
import { runnerUnavailable } from '../src/domain/candidate/restricted-runner.js'

describe('OS network sandbox', () => {
  it('treats sandbox usability as a successful sandboxed process start', () => {
    const sandbox = detectOsNetworkSandbox()
    assert.ok(sandbox, 'this host must provide a usable sandbox-exec or unshare --net')
    assert.equal(probeOsNetworkSandbox(sandbox), true)
    const workspace = mkdtempSync(path.join(tmpdir(), 'dsh-sandbox-'))
    const wrapped = wrapWithOsNetworkSandbox(sandbox, [process.execPath, '--version'], workspace)
    if (sandbox.kind === 'sandbox-exec') {
      assert.equal(wrapped.file, '/usr/bin/sandbox-exec')
      assert.equal(wrapped.args[0], '-f')
      assert.match(wrapped.args[1] ?? '', /network\.sb$/)
    } else {
      assert.equal(wrapped.file, '/usr/bin/unshare')
      assert.deepEqual(wrapped.args.slice(0, 4), ['--user', '--map-root-user', '--net', '--'])
    }
    assert.ok(wrapped.args.includes(process.execPath))
  })

  it('classifies EPERM sandbox startup as unavailable, not a candidate-test failure', () => {
    assert.equal(sandboxStartupUnavailable({ code: 'EPERM', stderr: 'unshare: failed to unshare namespaces: Operation not permitted' }), true)
    assert.equal(runnerUnavailable({ code: 'EPERM', stderr: 'unshare: failed to unshare namespaces: Operation not permitted' }), true)
    assert.equal(sandboxStartupUnavailable({
      stdout: '✖ outbound http2\nAssertionError [ERR_ASSERTION]: http2 connected\n',
      stderr: '',
    }), false)
  })
})
