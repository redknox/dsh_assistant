/** UI-facing snapshot of a live assistant agent. No UI implementation. */
export interface AssistantStatusProjection {
  readonly sessionId: string
  readonly live: boolean
}

export function projectAssistantStatus(sessionId: string, live: boolean): AssistantStatusProjection {
  return { sessionId, live }
}
