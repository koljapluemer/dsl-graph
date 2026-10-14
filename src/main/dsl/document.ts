import { parse } from 'yaml'
import { blockKeyword, endsBlock, isSectionOpener } from './openers'
import type { BlockKind, Schema } from './schema'
import { SectionParser } from './section-parser'

/** One `keyword arg* (option value)*` clause; values as their token text. */
export interface Clause {
  keyword: string
  line: number
  args: string[]
  options: Record<string, string>
}

/** `-> label @target`. An empty label means the relationship is unlabeled. */
export interface Relation {
  label: string
  target: string
  line: number
}

/**
 * One non-blank keyword-section line. `raw` is its trimmed text, which a writer
 * puts back verbatim unless it means to change that line.
 */
export type SectionLine =
  | { kind: 'clauses'; raw: string; line: number; clauses: Clause[]; unknownTail: string | null }
  | { kind: 'relation'; raw: string; line: number; relation: Relation | null }
  | { kind: 'state'; raw: string; line: number; clause: Clause | null; unknown: boolean }

export type DiagnosticCode =
  | 'empty'
  | 'missing_arg'
  | 'invalid_value'
  | 'unexpected_token'
  | 'duplicate_keyword'
  | 'conflicting_keywords'
  | 'invalid_relation'
  | 'invalid_state'
  | 'empty_extra'
  | 'empty_data'
  | 'invalid_yaml'
  | 'unknown_keyword'

export interface Diagnostic {
  code: DiagnosticCode
  /** 1-based, when the problem has a line. */
  line: number | null
  detail: string | null
}

/** A file parsed per the dsl spec's `language.md`, before any frontend gives its keywords meaning. */
export interface Document {
  /** Verbatim body lines; empty only for an empty file. */
  body: string[]
  section: SectionLine[]
  /** Verbatim `extra` block lines, or null when the file has none. */
  extra: string[] | null
  /** Verbatim `data` block lines (a YAML mapping), or null when the file has none. */
  data: string[] | null
  diagnostics: Diagnostic[]
}

export function isWarning(diagnostic: Diagnostic): boolean {
  return diagnostic.code === 'unknown_keyword'
}

export function errorsOf(doc: Document): Diagnostic[] {
  return doc.diagnostics.filter((diagnostic) => !isWarning(diagnostic))
}

export function clausesOf(doc: Document): Clause[] {
  return doc.section.flatMap((line) => (line.kind === 'clauses' ? line.clauses : []))
}

export function relationsOf(doc: Document): Relation[] {
  return doc.section.flatMap((line) =>
    line.kind === 'relation' && line.relation ? [line.relation] : []
  )
}

export function stateOf(doc: Document): Clause[] {
  return doc.section.flatMap((line) => (line.kind === 'state' && line.clause ? [line.clause] : []))
}

/** Unknown keyword lines from the keyword on; whole state lines. */
export function unknownOf(doc: Document): string[] {
  return doc.section.flatMap((line) => {
    if (line.kind === 'clauses' && line.unknownTail !== null) return [line.unknownTail]
    if (line.kind === 'state' && line.unknown) return [line.raw]
    return []
  })
}

/** Parses one item file. Never throws - problems become diagnostics. */
export function parseDocument(schema: Schema, text: string): Document {
  const lines = text.split('\n').map((line) => line.replace(/\r/g, ''))

  const first = lines.findIndex((line) => line.trim().length > 0)
  if (first === -1) {
    return {
      body: [],
      section: [],
      extra: null,
      data: null,
      diagnostics: [{ code: 'empty', line: null, detail: null }]
    }
  }

  const boundary = findIndexFrom(lines, first + 1, (line) => isSectionOpener(schema, line))

  const parser = new SectionParser(schema)
  const blocks = new Map<string, string[]>()
  for (let i = boundary; i < lines.length; ) {
    const keyword = blockKeyword(schema, lines[i])
    if (keyword === null) {
      parser.parseLine(lines[i], i + 1)
      i++
      continue
    }
    const end = findIndexFrom(lines, i + 1, (line) => endsBlock(schema, line))
    if (parser.claimBlock(keyword, i + 1)) {
      const content = trimBlankEnds(lines.slice(i + 1, end))
      blocks.set(keyword, content)
      checkBlock(parser, schema.keywords.get(keyword)!.block!, keyword, content, i + 1)
    }
    i = end
  }
  parser.checkExcludes()

  return {
    body: trimBlankEnds(lines.slice(first, boundary)),
    section: parser.lines,
    extra: blocks.get('extra') ?? null,
    data: blocks.get('data') ?? null,
    diagnostics: parser.diagnostics
  }
}

function checkBlock(
  parser: SectionParser,
  kind: BlockKind,
  keyword: string,
  content: string[],
  lineNo: number
): void {
  if (content.length === 0) {
    parser.report(kind === 'yaml' ? 'empty_data' : 'empty_extra', lineNo, keyword)
  } else if (kind === 'yaml' && !isYamlMapping(content.join('\n'))) {
    parser.report('invalid_yaml', lineNo, keyword)
  }
}

function isYamlMapping(text: string): boolean {
  try {
    const value: unknown = parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  } catch {
    return false
  }
}

/** First index at or after `from` whose line satisfies `predicate`, or `lines.length`. */
function findIndexFrom(
  lines: string[],
  from: number,
  predicate: (line: string) => boolean
): number {
  for (let i = from; i < lines.length; i++) {
    if (predicate(lines[i])) {
      return i
    }
  }
  return lines.length
}

export function trimBlankEnds(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && lines[start].trim().length === 0) start++
  while (end > start && lines[end - 1].trim().length === 0) end--
  return lines.slice(start, end)
}
