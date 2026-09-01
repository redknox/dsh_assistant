import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it } from 'node:test'
import { SystemInfoWorkspace } from '../web/src/SystemInfoWorkspace.js'

describe('System Info workspace', () => {
  it('presents built-ins as system facts and separates availability from action approval', () => {
    const markup = renderToStaticMarkup(createElement(SystemInfoWorkspace, {
      openSettings() {},
      view: {
        systemState: 'READY',
        capabilities: [
          { area: 'Calendar', action: 'Read schedule', status: 'active', advanced: { provider: 'google' } },
          { area: 'Calendar', action: 'Create event', status: 'approval-required', advanced: { provider: 'google' } },
          { area: 'Memory', action: 'Remember facts', status: 'active' },
          { area: 'Mail', action: 'Read mail', status: 'not-connected', advanced: { provider: 'fake' } },
        ],
        runtimeContext: {
          profile: 'assistant', workspaceLabel: 'workspace', workspaceIdentity: 'workspace-1', sessionId: 'main',
          sessionPersistence: 'persistent', safeMode: false,
        },
        contextEndurance: { status: 'ready', compaction: 'automatic', checkpoint: 'active', outputRetention: { maxInlineBytes: 1000, spill: 'ready' } },
        materialInput: { fileReferences: 'active', imageStore: 'ready', imageInput: 'unsupported' },
      },
    }))

    assert.match(markup, /SYSTEM INFO/)
    assert.match(markup, /Calendar/)
    assert.match(markup, /Create event.*APPROVAL ON USE/s)
    assert.match(markup, /data-system-surface="calendar" data-availability="available"/)
    assert.match(markup, /data-system-surface="mail" data-availability="not-connected"/)
    assert.match(markup, /NOT CONNECTED/)
    assert.doesNotMatch(markup, /fake|UNPLUG|USER-ADDED/)
    assert.match(markup, /SYSTEM FACTS, NOT USER INSTALLATIONS/)
  })
})
