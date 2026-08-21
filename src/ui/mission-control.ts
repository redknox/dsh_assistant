import type { MissionControlView } from '../domain/workspace/types.js'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** Text Mission-Control surface. Framework-independent. */
export function renderMissionControlAsText(view: MissionControlView): string {
  const lines = [
    `${view.identity}    ${view.objective?.text ?? '(no objective)'}    ${view.systemState}`,
    view.recovery ? `SAFE/RECOVERY  ${view.recovery.why}` : '',
    '',
    '# Context',
    ...view.memory.slice(0, 5).map((item) => `- Memory  ${item.topicKey}: ${item.statement}`),
    ...view.knowledge.slice(0, 5).map((item) => `- Knowledge  ${item.sourceUri}`),
    ...view.capabilities.map((item) => `- ${item.area}  ${item.action}  ${item.status}`),
    '',
    '# Conversation / work',
    ...view.conversation.map((item) => `[${item.kind}] ${item.text}`),
    ...view.approvals.map((card) => [
      `[approval-request] ${card.title}`,
      `  target: ${card.target}`,
      `  side effect: ${card.sideEffect}`,
      `  authority change: ${card.authorityChange}`,
      ...card.details.map((line) => `  ${line}`),
    ]).flat(),
    '',
    '# Activity',
    ...view.activity.map((item) => `- ${item.kind}  ${item.summary}`),
    '',
    '# Control',
    `pending-approvals=${view.controlStrip.pendingApprovals} jobs=${view.controlStrip.backgroundJobs} mode=${view.controlStrip.mode}`,
    view.controlStrip.degradation ? `degraded: ${view.controlStrip.degradation}` : '',
    `personality humor=${view.personality.humor} directness=${view.personality.directness} suppressed=${view.personality.humorSuppressed}`,
    'development-control-plane=separated',
  ]
  return lines.filter((line) => line !== '').join('\n')
}

/** Desktop-first HTML prototype. Original industrial language; not a movie UI. */
export function renderMissionControlAsHtml(view: MissionControlView): string {
  const recovery = view.recovery
    ? `<section id="recovery" data-state="${escapeHtml(view.systemState)}">
        <h1>TARS-NG — ${escapeHtml(view.systemState)}</h1>
        <p>${escapeHtml(view.recovery.why)}</p>
        <p>Disabled: ${escapeHtml(view.recovery.disabled.join(', ') || 'generated/optional capabilities')}</p>
        <ul>${view.recovery.actions.map((action) => `<li>${escapeHtml(action)}</li>`).join('')}</ul>
      </section>`
    : ''
  const context = [
    ...view.memory.map((item) => `<li data-memory-id="${escapeHtml(item.id)}">${escapeHtml(item.topicKey)}: ${escapeHtml(item.statement)}</li>`),
    ...view.knowledge.map((item) => `<li>${escapeHtml(item.sourceUri)}</li>`),
    ...view.capabilities.map((item) => `<li data-area="${escapeHtml(item.area)}" data-status="${escapeHtml(item.status)}">${escapeHtml(item.area)} — ${escapeHtml(item.action)} (${escapeHtml(item.status)})</li>`),
  ].join('')
  const conversation = view.conversation.map((item) => `<li data-kind="${escapeHtml(item.kind)}">${escapeHtml(item.text)}</li>`).join('')
  const approvals = view.approvals.map((card) => `<article data-approval-id="${escapeHtml(card.id)}" data-kind="${escapeHtml(card.kind)}" data-fingerprint="${escapeHtml(card.fingerprint)}">
      <h2>${escapeHtml(card.title)}</h2>
      <p>Target ${escapeHtml(card.target)}</p>
      <p>External side effect: ${escapeHtml(card.sideEffect)}</p>
      <p>Authority change: ${escapeHtml(card.authorityChange)}</p>
      <ul>${card.details.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
    </article>`).join('')
  const activity = view.activity.map((item) => `<li data-activity="${escapeHtml(item.kind)}" data-source="${escapeHtml(item.source)}">${escapeHtml(item.summary)}</li>`).join('')
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>TARS-NG</title>
  <style>
    :root { color-scheme: light dark; --ink: #1b1d1f; --paper: #f4f1ea; --line: #cfc8bc; --accent: #2f5d50; --warn: #8a3b2b; --type: "Iowan Old Style", "Palatino Linotype", Palatino, serif; }
    body { margin: 0; font-family: var(--type); background: var(--paper); color: var(--ink); }
    header, footer { display: flex; justify-content: space-between; gap: 1rem; padding: 0.75rem 1rem; border-bottom: 1px solid var(--line); }
    footer { border-top: 1px solid var(--line); border-bottom: 0; font-size: 0.9rem; }
    #layout { display: grid; grid-template-columns: 14rem 1fr 16rem; min-height: calc(100vh - 6rem); }
    aside, main { padding: 1rem; }
    #activity { border-left: 1px solid var(--line); }
    #context { border-right: 1px solid var(--line); }
    h1, h2 { font-size: 1rem; letter-spacing: 0.04em; text-transform: uppercase; }
    [data-state="SAFE_MODE"], [data-state="RECOVERY"] { background: #efe4d8; color: var(--warn); }
    #identity { font-weight: 700; }
    button { font: inherit; border: 1px solid var(--ink); background: transparent; padding: 0.25rem 0.6rem; }
  </style>
</head>
<body data-identity="TARS-NG" data-system-state="${escapeHtml(view.systemState)}" data-control-plane="user-workspace">
  <header>
    <div id="identity">TARS-NG</div>
    <div id="objective">${escapeHtml(view.objective?.text ?? 'No active objective')}</div>
    <div id="system-state">${escapeHtml(view.systemState)}</div>
  </header>
  ${recovery}
  <div id="layout">
    <aside id="context"><h1>Context</h1><ul>${context}</ul></aside>
    <main id="work">
      <h1>Conversation / work</h1>
      <ol>${conversation}</ol>
      <section id="approvals">${approvals}</section>
    </main>
    <aside id="activity"><h1>Activity</h1><ul>${activity}</ul></aside>
  </div>
  <footer id="control-strip" data-mode="${escapeHtml(view.controlStrip.mode)}">
    <span>Approvals ${view.controlStrip.pendingApprovals}</span>
    <span>Jobs ${view.controlStrip.backgroundJobs}</span>
    <span>${escapeHtml(view.controlStrip.degradation ?? 'Providers ready')}</span>
    <span>Humor ${view.personality.humor}${view.personality.humorSuppressed ? ' (suppressed)' : ''}</span>
  </footer>
</body>
</html>`
}
