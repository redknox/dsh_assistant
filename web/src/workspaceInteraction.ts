import type { UserPluginView } from '../../src/domain/workspace/types'

export interface WorkspaceInteractionState {
  readonly confirmingSession?: string
  readonly confirmingPlugin?: UserPluginView
  readonly confirmingUnplug?: UserPluginView
  readonly inspectingExtension?: string
}

export type WorkspaceInteractionEvent =
  | { readonly action: 'inspect-extension'; readonly id: string }
  | { readonly action: 'ask-conversation-delete'; readonly id: string }
  | { readonly action: 'confirm-conversation-delete'; readonly id: string }
  | { readonly action: 'ask-plugin-uninstall'; readonly plugin: UserPluginView }
  | { readonly action: 'cancel-plugin-uninstall' }
  | { readonly action: 'confirm-plugin-uninstall'; readonly id: string }
  | { readonly action: 'ask-capability-unplug'; readonly plugin: UserPluginView }
  | { readonly action: 'cancel-capability-unplug' }
  | { readonly action: 'confirm-capability-unplug'; readonly id: string }

export type WorkspaceInteractionCommand =
  | { readonly action: 'delete-conversation'; readonly id: string }
  | { readonly action: 'uninstall-plugin'; readonly plugin: UserPluginView }
  | { readonly action: 'disable-plugin'; readonly plugin: UserPluginView }

export const EMPTY_WORKSPACE_INTERACTION: WorkspaceInteractionState = {}

export function transitionWorkspaceInteraction(
  state: WorkspaceInteractionState,
  event: WorkspaceInteractionEvent,
): { readonly state: WorkspaceInteractionState; readonly command?: WorkspaceInteractionCommand } {
  if (event.action === 'inspect-extension') {
    return {
      state: {
        ...state,
        inspectingExtension: state.inspectingExtension === event.id ? undefined : event.id,
      },
    }
  }
  if (event.action === 'ask-conversation-delete') {
    return { state: { ...state, confirmingSession: event.id } }
  }
  if (event.action === 'confirm-conversation-delete') {
    if (state.confirmingSession !== event.id) return { state }
    return {
      state: { ...state, confirmingSession: undefined },
      command: { action: 'delete-conversation', id: event.id },
    }
  }
  if (event.action === 'ask-plugin-uninstall') {
    return { state: { ...state, confirmingPlugin: event.plugin } }
  }
  if (event.action === 'cancel-plugin-uninstall') {
    return { state: { ...state, confirmingPlugin: undefined } }
  }
  if (event.action === 'ask-capability-unplug') {
    return { state: { ...state, confirmingUnplug: event.plugin } }
  }
  if (event.action === 'cancel-capability-unplug') {
    return { state: { ...state, confirmingUnplug: undefined } }
  }
  if (event.action === 'confirm-capability-unplug') {
    if (state.confirmingUnplug?.id !== event.id) return { state }
    return {
      state: { ...state, confirmingUnplug: undefined },
      command: { action: 'disable-plugin', plugin: state.confirmingUnplug },
    }
  }
  if (state.confirmingPlugin?.id !== event.id) return { state }
  return {
    state: { ...state, confirmingPlugin: undefined },
    command: { action: 'uninstall-plugin', plugin: state.confirmingPlugin },
  }
}
