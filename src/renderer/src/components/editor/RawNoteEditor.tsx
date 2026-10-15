import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { EditorState, type Range } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { useEffect, useMemo, useRef, useState } from 'react'
import { isWarning, parseDocument } from '../../../../shared/dsl/document'
import { highlight } from '../../../../shared/dsl/highlight'
import { ITEM_SCHEMA } from '../../../../shared/dsl/item-schema'

export interface RawNoteEditorProps {
  initialText: string
  onChange: (text: string) => void
  /** Mod-Enter. */
  onSubmit: () => void
  /** Escape. */
  onCancel: () => void
  /** A pasted image or video, instead of inserting anything. */
  onPasteFile: (file: File) => void
}

/** Token classes (`tok-<kind>`, see main.css) for the item language, plus problem lines. */
function decorations(view: EditorView): DecorationSet {
  const text = view.state.doc.toString()
  const ranges: Range<Decoration>[] = highlight(ITEM_SCHEMA, text)
    .filter((span) => span.to > span.from)
    .map((span) => Decoration.mark({ class: `tok-${span.kind}` }).range(span.from, span.to))

  for (const diagnostic of parseDocument(ITEM_SCHEMA, text).diagnostics) {
    if (diagnostic.line !== null && diagnostic.line <= view.state.doc.lines) {
      const cls = isWarning(diagnostic) ? 'tok-warning-line' : 'tok-error-line'
      ranges.push(Decoration.line({ class: cls }).range(view.state.doc.line(diagnostic.line).from))
    }
  }
  return Decoration.set(ranges, true)
}

const itemLanguage = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = decorations(view)
    }

    update(update: ViewUpdate): void {
      if (update.docChanged) {
        this.decorations = decorations(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
)

/**
 * A note file's full text in a CodeMirror editor, highlighted per the item
 * language, with the parser's problems listed below it.
 */
export default function RawNoteEditor({
  initialText,
  onChange,
  onSubmit,
  onCancel,
  onPasteFile
}: RawNoteEditorProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [text, setText] = useState(initialText)
  // The editor is created once; it calls whatever handlers are current.
  const handlers = useRef({ onChange, onSubmit, onCancel, onPasteFile })
  useEffect(() => {
    handlers.current = { onChange, onSubmit, onCancel, onPasteFile }
  })

  useEffect(() => {
    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        doc: initialText,
        extensions: [
          history(),
          keymap.of([
            { key: 'Mod-Enter', run: () => (handlers.current.onSubmit(), true) },
            { key: 'Escape', run: () => (handlers.current.onCancel(), true) },
            ...defaultKeymap,
            ...historyKeymap
          ]),
          EditorView.lineWrapping,
          itemLanguage,
          EditorView.domEventHandlers({
            paste: (event) => {
              const file = Array.from(event.clipboardData?.files ?? []).find(
                (item) => item.type.startsWith('image/') || item.type.startsWith('video/')
              )
              if (!file) {
                return false
              }
              event.preventDefault()
              handlers.current.onPasteFile(file)
              return true
            }
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const next = update.state.doc.toString()
              setText(next)
              handlers.current.onChange(next)
            }
          })
        ]
      })
    })
    // Deferred a frame, like the draft card's textarea: React Flow may still be
    // settling focus when this mounts.
    const frame = requestAnimationFrame(() => view.focus())
    return () => {
      cancelAnimationFrame(frame)
      view.destroy()
    }
    // initialText seeds the editor once; later edits live in the editor itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const problems = useMemo(() => parseDocument(ITEM_SCHEMA, text).diagnostics, [text])

  return (
    <div className="nodrag nowheel nopan" onKeyDown={(event) => event.stopPropagation()}>
      <div
        ref={hostRef}
        className="raw-note-editor rounded-field border border-base-300 text-sm focus-within:border-primary/60"
      />
      {problems.length > 0 ? (
        <ul className="mt-2 space-y-0.5 text-xs">
          {problems.map((problem, index) => (
            <li key={index} className={isWarning(problem) ? 'text-warning' : 'text-error'}>
              {problem.line !== null ? `Line ${problem.line}: ` : ''}
              {problem.code}
              {problem.detail ? ` (${problem.detail})` : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
