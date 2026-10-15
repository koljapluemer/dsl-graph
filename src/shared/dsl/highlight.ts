import { blockKeyword, endsBlock, isRelationLine, isSectionOpener } from './openers'
import type { KeywordSpec, Role, Schema } from './schema'
import { tokenize } from './tokens'

/** What a stretch of item text is. Keyword kinds are named after their role. */
export type SpanKind =
  Role | 'option' | 'value' | 'tag' | 'relation' | 'target' | 'blockMarker' | 'block' | 'unknown'

/** A highlighted stretch of the text, as offsets (end exclusive). */
export interface Span {
  from: number
  to: number
  kind: SpanKind
}

const KEYWORD_TOKEN = /^[a-z]+$/

/**
 * Spans for syntax highlighting, in text order; body lines get none. Follows the
 * file structure of `language.md` like `parseDocument` does, but only classifies
 * tokens - problems are `parseDocument`'s diagnostics.
 */
export function highlight(schema: Schema, text: string): Span[] {
  const lines = text.split('\n')
  const starts: number[] = []
  lines.reduce((at, line) => {
    starts.push(at)
    return at + line.length + 1
  }, 0)

  const spans: Span[] = []
  const first = lines.findIndex((line) => line.trim().length > 0)
  if (first === -1) {
    return spans
  }

  let i = first + 1
  while (i < lines.length && !isSectionOpener(schema, lines[i])) {
    i++
  }

  while (i < lines.length) {
    const keyword = blockKeyword(schema, lines[i])
    if (keyword === null) {
      sectionLine(schema, lines[i], starts[i], spans)
      i++
      continue
    }
    spans.push({ from: starts[i], to: starts[i] + keyword.length, kind: 'blockMarker' })
    let end = i + 1
    while (end < lines.length && !endsBlock(schema, lines[end])) {
      end++
    }
    if (end > i + 1) {
      spans.push({
        from: starts[i + 1],
        to: starts[end - 1] + lines[end - 1].length,
        kind: 'block'
      })
    }
    i = end
  }
  return spans
}

function sectionLine(schema: Schema, line: string, at: number, spans: Span[]): void {
  const trimmed = line.trim()
  if (!trimmed) {
    return
  }
  const from = at + line.indexOf(trimmed)
  const to = from + trimmed.length

  if (isRelationLine(trimmed)) {
    spans.push({ from, to: from + 2, kind: 'relation' })
    const target = trimmed.split(/\s+/).at(-1)!
    if (target.startsWith('@')) {
      spans.push({ from: to - target.length, to, kind: 'target' })
    }
    return
  }

  if (trimmed.startsWith('(')) {
    const keyword = /^\(([a-z]+)/.exec(trimmed)?.[1]
    const known = keyword !== undefined && schema.keywords.get(keyword)?.role === 'state'
    spans.push({ from, to, kind: known ? 'state' : 'unknown' })
    return
  }

  const tokens = tokenize(line)
  let spec: KeywordSpec | null = null
  let argsLeft = 0
  let optionValue = false
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t]
    const span = { from: at + token.start, to: at + token.end }
    const known = token.quoted ? undefined : schema.keywords.get(token.text)

    if (optionValue || (argsLeft > 0 && !known)) {
      spans.push({ ...span, kind: 'value' })
      if (optionValue) {
        optionValue = false
      } else {
        argsLeft--
      }
    } else if (spec?.options.has(token.text) && !token.quoted) {
      spans.push({ ...span, kind: 'option' })
      optionValue = true
    } else if (known) {
      spans.push({ ...span, kind: known.role })
      spec = known
      argsLeft = known.args.length
      const rest = known.args.length === 1 ? known.args[0].types : []
      if (rest.length === 1 && (rest[0] === 'text' || rest[0] === 'tags')) {
        // Rest-of-line values: their words are never keywords.
        for (const value of tokens.slice(t + 1)) {
          spans.push({
            from: at + value.start,
            to: at + value.end,
            kind: rest[0] === 'tags' ? 'tag' : 'value'
          })
        }
        return
      }
    } else if (!token.quoted && KEYWORD_TOKEN.test(token.text)) {
      spans.push({ ...span, to, kind: 'unknown' })
      return
    } else {
      spans.push({ ...span, kind: 'value' })
    }
  }
}
