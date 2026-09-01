import { useEffect, useState } from 'react'
import type { MissionControlView } from '../../src/domain/workspace/types'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import type { ToolCatalogView } from '../../src/domain/tool-catalog/index'
import type { WorkflowCatalogView } from '../../src/domain/workflow-catalog/index'
import {
  establishSession,
  fetchView,
  openViewStream,
  type UiEnvelope,
} from './api'

export interface MissionControlRuntime {
  readonly view?: MissionControlView
  readonly connected: boolean
  readonly commands: readonly CommandDescriptor[]
  readonly toolCatalog?: ToolCatalogView
  readonly workflowCatalog?: WorkflowCatalogView
  readonly error?: string
  readonly acknowledgement?: { readonly text: string }
  readonly perform: (
    operation: () => Promise<UiEnvelope>,
    failureMessage?: string,
  ) => Promise<UiEnvelope | undefined>
  readonly dismissAcknowledgement: () => void
}

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback
}

export function useMissionControlRuntime(): MissionControlRuntime {
  const [envelope, setEnvelope] = useState<UiEnvelope>()
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string>()
  const [acknowledgement, setAcknowledgement] = useState<{ readonly text: string }>()

  useEffect(() => {
    let closed = false
    let stop = () => {}
    void (async () => {
      try {
        await establishSession()
        if (closed) return
        const next = await fetchView()
        if (!closed) setEnvelope(next)
      } catch (caught: unknown) {
        if (!closed) setError(errorMessage(caught, 'unable to load workspace'))
      }
      if (closed) return
      stop = openViewStream((next) => setEnvelope(next), setConnected)
    })()
    return () => {
      closed = true
      stop()
    }
  }, [])

  useEffect(() => {
    if (!acknowledgement) return
    const timer = globalThis.setTimeout(() => setAcknowledgement(undefined), 4000)
    return () => globalThis.clearTimeout(timer)
  }, [acknowledgement])

  const perform = async (
    operation: () => Promise<UiEnvelope>,
    failureMessage = 'action failed',
  ): Promise<UiEnvelope | undefined> => {
    setError(undefined)
    try {
      const next = await operation()
      setEnvelope(next)
      if (next.acknowledgement) setAcknowledgement(next.acknowledgement)
      return next
    } catch (caught) {
      setError(errorMessage(caught, failureMessage))
      return undefined
    }
  }

  return {
    view: envelope?.view,
    commands: envelope?.commands ?? [],
    toolCatalog: envelope?.toolCatalog,
    workflowCatalog: envelope?.workflowCatalog,
    connected,
    error,
    acknowledgement,
    perform,
    dismissAcknowledgement: () => setAcknowledgement(undefined),
  }
}
