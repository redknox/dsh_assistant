import type { AssistantView, ConversationItemDto } from './dto.js'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function conversationLine(item: ConversationItemDto): string {
  if (item.kind === 'tool_call') return `[tool_call ${item.toolName ?? ''} ${item.callId ?? ''}] ${item.text}`
  if (item.kind === 'tool_result') return `[tool_result ${item.callId ?? ''}] ${item.text}`
  return `[${item.kind}] ${item.text}`
}

/** Framework-independent text control surface. */
export function renderAssistantViewAsText(view: AssistantView): string {
  const lines = [
    `session ${view.sessionId}${view.agentStatus ? ` (${view.agentStatus})` : ''}`,
    '',
    '# Conversation',
    ...view.conversation.map(conversationLine),
    '',
    '# Jobs',
    ...view.jobs.map((job) => `- ${job.name} ${job.schedule}${job.lastRunStatus ? ` last=${job.lastRunStatus}` : ''}${job.lastRunId ? ` ${job.lastRunId}` : ''}`),
    '',
    '# Confirmations',
    ...view.confirmations.map((item) => `- ${item.id} ${item.level} ${item.capability}.${item.operation} ${item.status} fingerprint=${item.fingerprint}`),
    '',
    '# Memory',
    ...view.memory.map((item) => `- ${item.id} [${item.category}/${item.status}] ${item.topicKey}: ${item.statement}`),
    '',
    '# Knowledge sources',
    ...view.knowledgeSources.map((item) => `- ${item.documentId} ${item.sourceKind} ${item.sourceUri}${item.title ? ` ${item.title}` : ''}`),
    '',
    '# Knowledge hits',
    ...(view.knowledgeTrace ? [`trace: ${view.knowledgeTrace}`] : []),
    ...view.knowledgeHits.map((item) => `- ${item.excerpt} — ${item.sourceUri}`),
    '',
    '# Capabilities',
    ...view.capabilities.map((item) => `- ${item.capability} ${item.available ? 'available' : 'unavailable'}${item.reason ? ` ${item.reason}` : ''}`),
  ]
  return lines.join('\n')
}

/** Minimal HTML control surface. Not a design system. */
export function renderAssistantViewAsHtml(view: AssistantView): string {
  const conversation = view.conversation.map((item) => `<li data-kind="${item.kind}" data-call-id="${escapeHtml(item.callId ?? '')}">${escapeHtml(conversationLine(item))}</li>`).join('')
  const jobs = view.jobs.map((job) => `<li data-run-id="${escapeHtml(job.lastRunId ?? '')}">${escapeHtml(job.title)} ${escapeHtml(job.lastRunStatus ?? 'idle')}</li>`).join('')
  const confirmations = view.confirmations.map((item) => `<li data-confirmation-id="${escapeHtml(item.id)}" data-fingerprint="${escapeHtml(item.fingerprint)}">${escapeHtml(item.capability)}.${escapeHtml(item.operation)} ${escapeHtml(item.status)}</li>`).join('')
  const memory = view.memory.map((item) => `<li data-memory-id="${escapeHtml(item.id)}">${escapeHtml(item.topicKey)}: ${escapeHtml(item.statement)} (${escapeHtml(item.status)})</li>`).join('')
  const sources = view.knowledgeSources.map((item) => `<li data-document-id="${escapeHtml(item.documentId)}">${escapeHtml(item.sourceUri)}</li>`).join('')
  const hits = view.knowledgeHits.map((item) => `<li data-chunk-id="${escapeHtml(item.chunkId)}">${escapeHtml(item.excerpt)}</li>`).join('')
  const capabilities = view.capabilities.map((item) => `<li>${escapeHtml(item.capability)}: ${item.available ? 'available' : 'unavailable'}</li>`).join('')
  return `<!doctype html>
<html lang="en">
<body>
  <main data-session="${escapeHtml(view.sessionId)}">
    <section id="conversation"><h1>Conversation</h1><ol>${conversation}</ol></section>
    <section id="jobs"><h1>Jobs</h1><ul>${jobs}</ul></section>
    <section id="confirmations"><h1>Confirmations</h1><ul>${confirmations}</ul></section>
    <section id="memory"><h1>Memory</h1><ul>${memory}</ul></section>
    <section id="knowledge-sources"><h1>Knowledge sources</h1><ul>${sources}</ul></section>
    <section id="knowledge-hits"><h1>Knowledge hits</h1><p>${escapeHtml(view.knowledgeTrace ?? '')}</p><ul>${hits}</ul></section>
    <section id="capabilities"><h1>Capabilities</h1><ul>${capabilities}</ul></section>
  </main>
</body>
</html>`
}
