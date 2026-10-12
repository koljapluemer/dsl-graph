import { trimBlankEnds, type Clause, type Document, type SectionLine } from './document'
import { EXTRA_MARKER, isSectionOpener } from './openers'
import type { Schema } from './schema'
import { formatToken } from './tokens'

/**
 * Writes a document back as item text: body, a blank line, the section lines,
 * then the extra block. Section lines keep their `raw` text, so lines a writer
 * didn't touch come back exactly as they were read.
 */
export function serializeDocument(schema: Schema, doc: Document): string {
  const body = trimBlankEnds(doc.body)
  if (body.length === 0) {
    throw new Error('An item needs a body.')
  }

  const lines = body.map((line, index) =>
    index > 0 && isSectionOpener(schema, line) ? ` ${line}` : line
  )
  const extra = doc.extra === null ? [] : trimBlankEnds(doc.extra)

  if (doc.section.length > 0 || extra.length > 0) {
    lines.push('')
  }
  lines.push(...doc.section.map((line) => line.raw))
  if (extra.length > 0) {
    lines.push(EXTRA_MARKER, ...extra)
  }
  return `${lines.join('\n')}\n`
}

/** Splits free text (a body or extra content) into lines, the way a file holds it. */
export function textLines(text: string): string[] {
  return trimBlankEnds(text.split(/\r?\n/))
}

export function relationLine(label: string, target: string): SectionLine {
  const trimmed = label.trim()
  const raw = trimmed ? `-> ${trimmed} @${target}` : `-> @${target}`
  return { kind: 'relation', raw, line: 0, relation: { label: trimmed, target, line: 0 } }
}

/** A line of clauses, plus an unknown keyword's raw tail kept from the line it came from. */
export function clauseLine(clauses: Clause[], unknownTail: string | null = null): SectionLine {
  const raw = [...clauses.map(formatClause), ...(unknownTail === null ? [] : [unknownTail])].join(
    ' '
  )
  return { kind: 'clauses', raw, line: 0, clauses, unknownTail }
}

function formatClause(clause: Clause): string {
  return [
    clause.keyword,
    ...clause.args.map(formatToken),
    ...Object.entries(clause.options).flatMap(([option, value]) => [option, formatToken(value)])
  ].join(' ')
}

/** Whether `target` can stand after the `@` of a relationship line. */
export function isValidRelationTarget(target: string): boolean {
  return target.length > 0 && !/[\s/\\]/.test(target)
}
