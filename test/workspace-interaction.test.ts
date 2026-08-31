import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { UserPluginView } from '../src/domain/workspace/types.js'
import {
  EMPTY_WORKSPACE_INTERACTION,
  transitionWorkspaceInteraction,
} from '../web/src/workspaceInteraction.js'

function plugin(overrides: Partial<UserPluginView> = {}): UserPluginView {
  return {
    id: 'plugin-1',
    owner: 'generated/example',
    version: '0.1.0',
    provenance: 'candidate',
    candidateId: 'candidate-1',
    digest: 'digest-1',
    capabilities: ['text.example'],
    tools: ['text_example'],
    mounted: true,
    registryGeneration: 3,
    dependency: { severity: 'none', dependents: [] },
    uninstallable: true,
    ...overrides,
  }
}

describe('Workspace interaction state', () => {
  it('toggles extension inspection by exact id', () => {
    const opened = transitionWorkspaceInteraction(EMPTY_WORKSPACE_INTERACTION, {
      action: 'inspect-extension',
      id: 'extension-1',
    })
    assert.equal(opened.state.inspectingExtension, 'extension-1')
    assert.equal(transitionWorkspaceInteraction(opened.state, {
      action: 'inspect-extension',
      id: 'extension-1',
    }).state.inspectingExtension, undefined)
  })

  it('executes conversation deletion only for the armed session', () => {
    const armed = transitionWorkspaceInteraction(EMPTY_WORKSPACE_INTERACTION, {
      action: 'ask-conversation-delete',
      id: 'session-1',
    })
    assert.equal(transitionWorkspaceInteraction(armed.state, {
      action: 'confirm-conversation-delete',
      id: 'session-2',
    }).command, undefined)
    assert.deepEqual(transitionWorkspaceInteraction(armed.state, {
      action: 'confirm-conversation-delete',
      id: 'session-1',
    }).command, { action: 'delete-conversation', id: 'session-1' })
  })

  it('binds plugin uninstall to the projection captured on the first click', () => {
    const original = plugin()
    const armed = transitionWorkspaceInteraction(EMPTY_WORKSPACE_INTERACTION, {
      action: 'ask-plugin-uninstall',
      plugin: original,
    })
    const confirmed = transitionWorkspaceInteraction(armed.state, {
      action: 'confirm-plugin-uninstall',
      id: original.id,
    })
    assert.deepEqual(confirmed.command, { action: 'uninstall-plugin', plugin: original })
    assert.equal(confirmed.state.confirmingPlugin, undefined)
  })

  it('rejects mismatched plugin confirmation and supports cancellation', () => {
    const armed = transitionWorkspaceInteraction(EMPTY_WORKSPACE_INTERACTION, {
      action: 'ask-plugin-uninstall',
      plugin: plugin(),
    })
    assert.equal(transitionWorkspaceInteraction(armed.state, {
      action: 'confirm-plugin-uninstall',
      id: 'plugin-2',
    }).command, undefined)
    assert.equal(transitionWorkspaceInteraction(armed.state, {
      action: 'cancel-plugin-uninstall',
    }).state.confirmingPlugin, undefined)
  })
})
