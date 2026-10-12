import { opensSection, type Schema } from './schema'

/** The line that starts an item's extra content (see language.md, "Extra"). */
export const EXTRA_MARKER = 'extra'

const KEYWORD_OPENER = /^([a-z]+)(?=\s|$)/
const STATE_OPENER = /^\(([a-z]+)(?=[\s)]|$)/
const RELATION_OPENER = /^->\s/

export function isExtraMarker(line: string): boolean {
  return line.trimEnd() === EXTRA_MARKER
}

/**
 * Whether a body line (other than the first) starts the keyword section.
 * Writers indent such lines to keep them in the body.
 */
export function isSectionOpener(schema: Schema, line: string): boolean {
  if (isExtraMarker(line)) {
    return true
  }
  if (RELATION_OPENER.test(line)) {
    return line.trim().split(/\s+/).at(-1)!.startsWith('@')
  }

  const state = STATE_OPENER.exec(line)
  if (state) {
    return schema.keywords.get(state[1])?.role === 'state'
  }

  const keyword = KEYWORD_OPENER.exec(line)
  const spec = keyword ? schema.keywords.get(keyword[1]) : undefined
  return spec !== undefined && opensSection(spec.role)
}

/** Whether a trimmed keyword-section line is a relationship line. */
export function isRelationLine(trimmed: string): boolean {
  return trimmed === '->' || RELATION_OPENER.test(trimmed)
}
