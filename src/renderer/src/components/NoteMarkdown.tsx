import { ExternalLink } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const PROSE_CLASS = [
  'prose prose-sm max-w-none',
  'prose-code:before:content-none prose-code:after:content-none',
  // Blockquotes: keep the accent bar + a subtle fill, drop the plugin's
  // bold + italic styling and the auto-inserted curly quote marks.
  'prose-blockquote:font-normal prose-blockquote:not-italic',
  'prose-blockquote: prose-blockquote:bg-base-200/60 prose-blockquote:py-2 prose-blockquote:pr-4',
  '[&_blockquote_p:first-of-type::before]:content-none',
  '[&_blockquote_p:last-of-type::after]:content-none'
].join(' ')

/** A note's Markdown (body or extra), with links opening externally. `small` sets it a size down. */
export default function NoteMarkdown({
  markdown,
  small = false
}: {
  markdown: string
  small?: boolean
}): React.JSX.Element {
  return (
    <div className={small ? `${PROSE_CLASS} text-xs!` : PROSE_CLASS}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1"
            >
              {children}
              <ExternalLink className="size-3" />
            </a>
          )
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  )
}
