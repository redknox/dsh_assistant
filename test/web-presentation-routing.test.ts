import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { recoveryActionId } from '../web/src/missionControlPresentation.js'
import { workspacePaneFromHash, workspacePaneHash } from '../web/src/workspaceRoute.js'

describe('Web UI presentation routing', () => {
  it('maps canonical workspace hashes and preserves the conversations alias', () => {
    assert.equal(workspacePaneFromHash('#today'), 'today')
    assert.equal(workspacePaneFromHash('#extensions'), 'extensions')
    assert.equal(workspacePaneFromHash('#memory'), 'memory')
    assert.equal(workspacePaneFromHash('#logs'), 'logs')
    assert.equal(workspacePaneFromHash('#conversations'), 'memory')
    assert.equal(workspacePaneFromHash('#unknown'), 'today')
    assert.equal(workspacePaneFromHash(undefined), 'today')
  })

  it('writes only canonical workspace hashes', () => {
    assert.equal(workspacePaneHash('today'), '#today')
    assert.equal(workspacePaneHash('memory'), '#memory')
    assert.equal(workspacePaneHash('extensions'), '#extensions')
    assert.equal(workspacePaneHash('logs'), '#logs')
  })

  it('maps only recovery actions supported by the Web UI', () => {
    assert.equal(recoveryActionId('Diagnostics'), 'diagnostics')
    assert.equal(recoveryActionId('Rollback'), 'rollback')
    assert.equal(recoveryActionId('Exit Safe Mode'), 'exit-safe-mode')
    assert.equal(recoveryActionId('Reinstall Profile'), undefined)
  })
})
