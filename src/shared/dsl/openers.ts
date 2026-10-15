import { opensSection, type Role, type Schema } from './schema'

const KEYWORD_OPENER = /^([a-z]+)(?=\s|$)/
const STATE_OPENER = /^\(([a-z]+)(?=[\s)]|$)/
const RELATION_OPENER = /^->\s/

/** The block keyword a line consists of (see language.md, "Block keywords"), or null. */
export function blockKeyword(schema: Schema, line: string): string | null {
  const name = line.trimEnd()
  return schema.keywords.get(name)?.block ? name : null
}

/**
 * Whether a line at column 0 is a keyword, relationship or state line whose
 * keyword role passes `roleCounts`. Block keywords count only alone on their line.
 */
function startsLine(schema: Schema, line: string, roleCounts: (role: Role) => boolean): boolean {
  if (RELATION_OPENER.test(line)) {
    return line.trim().split(/\s+/).at(-1)!.startsWith('@')
  }

  const state = STATE_OPENER.exec(line)
  if (state) {
    return schema.keywords.get(state[1])?.role === 'state' && roleCounts('state')
  }

  const keyword = KEYWORD_OPENER.exec(line)
  const spec = keyword ? schema.keywords.get(keyword[1]) : undefined
  if (!spec || !roleCounts(spec.role)) {
    return false
  }
  return !spec.block || line.trimEnd() === spec.name
}

/**
 * Whether a body line (other than the first) starts the keyword section.
 * Writers indent such lines to keep them in the body.
 */
export function isSectionOpener(schema: Schema, line: string): boolean {
  return startsLine(schema, line, opensSection)
}

/** Whether a line terminates a block. Writers indent such lines to keep them in it. */
export function endsBlock(schema: Schema, line: string): boolean {
  return startsLine(schema, line, () => true)
}

/** Whether a trimmed keyword-section line is a relationship line. */
export function isRelationLine(trimmed: string): boolean {
  return trimmed === '->' || RELATION_OPENER.test(trimmed)
}
