import React from 'react'

const strokes: Record<string, readonly string[]> = {
  today: ['M12 4v2', 'M12 18v2', 'M4 12h2', 'M18 12h2', 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z'],
  conversations: ['M5 8h8a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H9l-3 2.5V15H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2z', 'M11 6h7a2 2 0 0 1 2 2v3'],
  calendar: ['M5 7h14v12H5z', 'M5 11h14', 'M8 5v4', 'M16 5v4'],
  memory: ['M8 4h8v16l-4-2.4L8 20z'],
  capabilities: ['M5 6h5v5H5z', 'M14 6h5v5h-5z', 'M5 14h5v5H5z', 'M14 14h5v5h-5z'],
  attach: ['M15 8.5v6.2a3 3 0 0 1-6 0V8a2.4 2.4 0 1 1 4.8 0v6.1a1.2 1.2 0 1 1-2.4 0V9'],
  send: ['M4 12h13', 'M13 7l5 5-5 5'],
  chip: ['M8 7h8v10H8z', 'M10 4v3', 'M14 4v3', 'M10 17v3', 'M14 17v3', 'M5 10H3', 'M5 14H3', 'M21 10h-2', 'M21 14h-2'],
  shield: ['M12 3.5l7.5 2.8v5.4c0 4.4-3.1 7.4-7.5 8.6-4.4-1.2-7.5-4.2-7.5-8.6V6.3z'],
  check: ['M6 12.2l3.6 3.6L18 8'],
  terminal: ['M4 6h16v12H4z', 'M7 10l2.2 2L7 14', 'M11.5 14H16'],
  hex: ['M12 3l8 4.6v8.8L12 21l-8-4.6V7.6z'],
  warn: ['M12 4.2l8.4 15.1H3.6z', 'M12 10v4', 'M12 16.6h.01'],
  trash: ['M5 7h14', 'M9 7V5h6v2', 'M7 7l1 13h8l1-13', 'M10 11v6', 'M14 11v6'],
  info: ['M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16z', 'M12 11v5', 'M12 8h.01'],
  settings: ['M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7z', 'M12 3v2', 'M12 19v2', 'M3 12h2', 'M19 12h2', 'M5.6 5.6L7 7', 'M17 17l1.4 1.4', 'M18.4 5.6L17 7', 'M7 17l-1.4 1.4'],
}

export type GlyphName = keyof typeof strokes

export function Glyph(props: { readonly name: GlyphName; readonly className?: string }) {
  return (
    <svg className={props.className ?? 'glyph'} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {strokes[props.name].map((d) => <path key={d} d={d} />)}
    </svg>
  )
}
