import { useRef, useState } from 'react'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import { decideCapabilityProposal, runConversation, sendMessage, type EncodedConversationImage } from './api'
import type { MissionControlRuntime } from './useMissionControlRuntime'

export type ConversationEvent =
  | { readonly action: 'draft'; readonly value: string }
  | { readonly action: 'suggest-skill'; readonly name: string }
  | { readonly action: 'send' }
  | { readonly action: 'add-images'; readonly files: readonly File[] }
  | { readonly action: 'remove-image'; readonly index: number }
  | { readonly action: 'create' }
  | { readonly action: 'start-capability'; readonly title: string; readonly draft: string }
  | { readonly action: 'decide-capability-proposal'; readonly id: string; readonly decision: 'declined' | 'started'; readonly draft?: string }
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
  readonly images: readonly EncodedConversationImage[]
  readonly imageError?: string
  readonly dispatch: (event: ConversationEvent) => void
}

export function useConversationControl(
  runtime: Pick<MissionControlRuntime, 'view' | 'commands' | 'perform'>,
): ConversationControl {
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [executingCommand, setExecutingCommand] = useState<string>()
  const [images, setImages] = useState<readonly EncodedConversationImage[]>([])
  const [imageError, setImageError] = useState<string>()
  const sendLocked = useRef(false)

  const send = async () => {
    const text = draft.trim()
    if (sendLocked.current || (text === '' && images.length === 0)) return
    const commandLine = text.startsWith('/') ? text : undefined
    if (commandLine && images.length > 0) {
      setImageError('Slash commands cannot include images. Remove the images or send a normal message.')
      return
    }
    sendLocked.current = true
    setSending(true)
    setExecutingCommand(commandLine)
    if (commandLine) setDraft((current) => current.trim() === text ? '' : current)
    try {
      const next = await runtime.perform(() => {
        const sessionId = runtime.view?.runtimeContext?.sessionId ?? runtime.view?.sessions?.currentSessionId
        if (!sessionId) throw new Error('current session is unknown')
        return sendMessage(text, sessionId, images)
      }, 'send failed')
      if (next && !commandLine) {
        setDraft((current) => current.trim() === text ? '' : current)
        setImages([])
        setImageError(undefined)
      }
    } finally {
      sendLocked.current = false
      setSending(false)
      setExecutingCommand(undefined)
    }
  }

  const runCatalogAction = (event: Exclude<ConversationEvent,
    { readonly action: 'draft' | 'suggest-skill' | 'send' | 'add-images' | 'remove-image' }
  >) => {
    const reference = {
      sessionId: runtime.view?.runtimeContext?.sessionId ?? runtime.view?.sessions?.currentSessionId ?? 'main',
      revision: runtime.view?.sessions?.revision ?? 0,
    }
    if (event.action === 'decide-capability-proposal') {
      void (async () => {
        const next = await runtime.perform(
          () => decideCapabilityProposal({ proposalId: event.id, decision: event.decision, ...reference }),
          'unable to update capability proposal',
        )
        if (next && event.decision === 'started' && event.draft) setDraft(event.draft)
      })()
      return
    }
    if (event.action === 'create') {
      void runtime.perform(() => runConversation('create', reference))
      return
    }
    if (event.action === 'start-capability') {
      void (async () => {
        const next = await runtime.perform(
          () => runConversation('create', { ...reference, title: event.title }),
          'unable to create capability delivery conversation',
        )
        if (next) setDraft(event.draft)
      })()
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
    images,
    imageError,
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
      if (event.action === 'add-images') {
        void encodeImages(event.files).then((next) => {
          setImages((current) => {
            if (current.length + next.length > 20) {
              setImageError('A message can contain at most 20 images.')
              return current
            }
            setImageError(undefined)
            return [...current, ...next]
          })
        }).catch((error: unknown) => {
          setImageError(error instanceof Error ? error.message : 'Unable to read image.')
        })
        return
      }
      if (event.action === 'remove-image') {
        setImages((current) => current.filter((_, index) => index !== event.index))
        setImageError(undefined)
        return
      }
      runCatalogAction(event)
    },
  }
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

async function encodeImages(files: readonly File[]): Promise<readonly EncodedConversationImage[]> {
  return Promise.all(files.map(async (file) => {
    if (!IMAGE_TYPES.has(file.type)) throw new Error(`${file.name}: use PNG, JPEG, WebP, or GIF.`)
    const dataUrl = await readDataUrl(file)
    const separator = dataUrl.indexOf(',')
    if (separator < 0) throw new Error(`${file.name}: unable to encode image.`)
    return {
      mediaType: file.type as EncodedConversationImage['mediaType'],
      data: dataUrl.slice(separator + 1),
      name: file.name,
    }
  }))
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Unable to read image.'))
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read image.'))
    reader.readAsDataURL(file)
  })
}
