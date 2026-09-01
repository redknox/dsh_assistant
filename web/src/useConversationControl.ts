import { useRef, useState } from 'react'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import { runConversation, sendMessage } from './api'
import type { MissionControlRuntime } from './useMissionControlRuntime'

export type ConversationEvent =
  | { readonly action: 'draft'; readonly value: string }
  | { readonly action: 'suggest-skill'; readonly name: string }
  | { readonly action: 'send' }
  | { readonly action: 'create' }
  | { readonly action: 'switch'; readonly id: string }
  | { readonly action: 'rename'; readonly id: string; readonly title: string }
  | { readonly action: 'archive'; readonly id: string }
  | { readonly action: 'restore'; readonly id: string }
  | { readonly action: 'delete'; readonly id: string }

export interface ConversationControl {
  readonly draft: string
  readonly sending: boolean
  readonly executingCommand?: string
  readonly commands: readonly CommandDescriptor[]
  readonly dispatch: (event: ConversationEvent) => void
}

export function useConversationControl(
  runtime: Pick<MissionControlRuntime, 'view' | 'commands' | 'perform'>,
): ConversationControl {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [executingCommand, setExecutingCommand] = useState<string>()
  const sendLocked = useRef(false)

  const send = async () => {
    const text = draft.trim()
    if (sendLocked.current || text === '') return
    const commandLine = text.startsWith('/') ? text : undefined
    sendLocked.current = true
    setSending(true)
    setExecutingCommand(commandLine)
    if (commandLine) setDraft((current) => current.trim() === text ? '' : current)
    try {
      const next = await runtime.perform(() => {
        const sessionId = runtime.view?.runtimeContext?.sessionId ?? runtime.view?.sessions?.currentSessionId
        if (!sessionId) throw new Error('current session is unknown')
        return sendMessage(text, sessionId)
      }, 'send failed')
      if (next && !commandLine) setDraft((current) => current.trim() === text ? '' : current)
    } finally {
      sendLocked.current = false
      setSending(false)
      setExecutingCommand(undefined)
    }
  }

  const runCatalogAction = (event: Exclude<ConversationEvent,
    { readonly action: 'draft' | 'suggest-skill' | 'send' }
  >) => {
    const reference = {
      sessionId: runtime.view?.runtimeContext?.sessionId ?? runtime.view?.sessions?.currentSessionId ?? 'main',
      revision: runtime.view?.sessions?.revision ?? 0,
    }
    if (event.action === 'create') {
      void runtime.perform(() => runConversation('create', reference))
      return
    }
    const input = {
      ...reference,
      id: event.id,
      ...(event.action === 'rename' ? { title: event.title } : {}),
      ...(event.action === 'delete' ? { confirm: true } : {}),
    }
    void runtime.perform(() => runConversation(event.action, input))
  }

  return {
    draft,
    sending,
    executingCommand,
    commands: runtime.commands,
    dispatch: (event) => {
      if (event.action === 'draft') {
        setDraft(event.value)
        return
      }
      if (event.action === 'suggest-skill') {
        setDraft((current) => current.trim() === '' ? `Use the ${event.name} skill.` : `${current.trim()} ${event.name}`)
        return
      }
      if (event.action === 'send') {
        void send()
        return
      }
      runCatalogAction(event)
    },
  }
}
