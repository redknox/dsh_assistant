import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Conversation Markdown policy, including safe links and non-truncating GFM tables. */
export function MarkdownMessage(props: { readonly text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        table({ node: _node, ...tableProps }) {
          return <div className="markdown-table-scroll"><table {...tableProps} /></div>
        },
        a({ node: _node, ...linkProps }) {
          return <a {...linkProps} target="_blank" rel="noreferrer noopener" />
        },
      }}
    >
      {props.text}
    </ReactMarkdown>
  )
}
