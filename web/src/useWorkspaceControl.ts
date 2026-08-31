import { useRef, useState } from 'react'
import { uninstallPlugin } from './api'
import type { ConversationControl } from './useConversationControl'
import type { MissionControlRuntime } from './useMissionControlRuntime'
import {
  EMPTY_WORKSPACE_INTERACTION,
  transitionWorkspaceInteraction,
  type WorkspaceInteractionEvent,
  type WorkspaceInteractionState,
} from './workspaceInteraction'

export interface WorkspaceControl {
  readonly state: WorkspaceInteractionState
  readonly dispatch: (event: WorkspaceInteractionEvent) => void
}

export function useWorkspaceControl(
  runtime: Pick<MissionControlRuntime, 'perform'>,
  conversation: Pick<ConversationControl, 'dispatch'>,
): WorkspaceControl {
  const [state, setState] = useState(EMPTY_WORKSPACE_INTERACTION)
  const stateRef = useRef<WorkspaceInteractionState>(EMPTY_WORKSPACE_INTERACTION)

  const commit = (next: WorkspaceInteractionState) => {
    stateRef.current = next
    setState(next)
  }

  return {
    state,
    dispatch: (event) => {
      const requested = transitionWorkspaceInteraction(stateRef.current, event)
      commit(requested.state)
      const command = requested.command
      if (command?.action === 'delete-conversation') {
        conversation.dispatch({ action: 'delete', id: command.id })
      } else if (command?.action === 'uninstall-plugin') {
        const { plugin } = command
        void runtime.perform(() => uninstallPlugin(plugin, true))
      }
    },
  }
}
