import type { Clause, Diagnostic, DiagnosticCode, Relation, SectionLine } from './document'
import { isRelationLine } from './openers'
import type { KeywordSpec, Schema } from './schema'
import { tokenize, type Token } from './tokens'
import { matchesValueType } from './values'

const KEYWORD_TOKEN = /^[a-z]+$/

/** Parses the keyword section line by line (see language.md, "Keyword section"). */
export class SectionParser {
  readonly lines: SectionLine[] = []
  readonly diagnostics: Diagnostic[] = []
  private readonly seen = new Set<string>()

  constructor(private readonly schema: Schema) {}

  /**
   * Registers a block keyword met in the section; false (with an error) when it
   * already appeared.
   */
  claimBlock(keyword: string, lineNo: number): boolean {
    if (this.seen.has(keyword)) {
      this.error('duplicate_keyword', lineNo, keyword)
      return false
    }
    this.seen.add(keyword)
    return true
  }

  report(code: DiagnosticCode, line: number, detail: string): void {
    this.error(code, line, detail)
  }

  parseLine(rawLine: string, lineNo: number): void {
    const raw = rawLine.trim()
    if (!raw) {
      return
    }

    if (isRelationLine(raw)) {
      this.lines.push({ kind: 'relation', raw, line: lineNo, relation: this.relation(raw, lineNo) })
    } else if (raw.startsWith('(')) {
      this.lines.push(this.stateLine(raw, lineNo))
    } else {
      this.lines.push(this.clauseLine(raw, lineNo))
    }
  }

  /** Reports each excluded pair once, on the later clause's line. */
  checkExcludes(): void {
    const clauses = this.lines.flatMap((line) => (line.kind === 'clauses' ? line.clauses : []))
    for (let a = 0; a < clauses.length; a++) {
      for (let b = a + 1; b < clauses.length; b++) {
        const first = clauses[a].keyword
        const second = clauses[b].keyword
        if (this.spec(first).excludes.has(second) || this.spec(second).excludes.has(first)) {
          this.error('conflicting_keywords', clauses[b].line, `${first}, ${second}`)
        }
      }
    }
  }

  private relation(raw: string, lineNo: number): Relation | null {
    const rest = raw.slice(2).trim()
    const target = rest ? rest.split(/\s+/).at(-1)! : ''
    if (target.length < 2 || !target.startsWith('@') || /[/\\]/.test(target)) {
      this.error('invalid_relation', lineNo, raw)
      return null
    }
    return { label: rest.slice(0, -target.length).trim(), target: target.slice(1), line: lineNo }
  }

  private stateLine(raw: string, lineNo: number): SectionLine {
    const line = { kind: 'state' as const, raw, line: lineNo, clause: null, unknown: false }
    if (!raw.endsWith(')')) {
      this.error('invalid_state', lineNo, raw)
      return line
    }

    const tokens = tokenize(raw.slice(1, -1))
    const keyword = tokens[0]
    if (!keyword || keyword.quoted || !KEYWORD_TOKEN.test(keyword.text)) {
      this.error('invalid_state', lineNo, raw)
      return line
    }

    const spec = this.schema.keywords.get(keyword.text)
    if (!spec) {
      this.diagnostics.push({ code: 'unknown_keyword', line: lineNo, detail: keyword.text })
      return { ...line, unknown: true }
    }
    if (spec.role !== 'state') {
      this.error('invalid_state', lineNo, raw)
      return line
    }

    const parsed = this.clause(tokens, 0, lineNo, raw.slice(1, -1))
    if (parsed && parsed.next < tokens.length) {
      this.error('unexpected_token', lineNo, tokens[parsed.next].text)
      return line
    }
    return { ...line, clause: parsed?.clause ?? null }
  }

  private clauseLine(raw: string, lineNo: number): SectionLine {
    const tokens = tokenize(raw)
    const line = {
      kind: 'clauses' as const,
      raw,
      line: lineNo,
      clauses: [] as Clause[],
      unknownTail: null as string | null
    }

    let i = 0
    while (i < tokens.length) {
      const token = tokens[i]
      if (token.quoted || !KEYWORD_TOKEN.test(token.text)) {
        this.error('unexpected_token', lineNo, token.text)
        return line
      }
      const spec = this.schema.keywords.get(token.text)
      if (!spec) {
        this.diagnostics.push({ code: 'unknown_keyword', line: lineNo, detail: token.text })
        return { ...line, unknownTail: raw.slice(token.start) }
      }
      if (spec.role === 'state' || spec.block) {
        this.error('unexpected_token', lineNo, token.text)
        return line
      }

      const parsed = this.clause(tokens, i, lineNo, raw)
      if (!parsed) {
        return line
      }
      line.clauses.push(parsed.clause)
      i = parsed.next
    }
    return line
  }

  /**
   * The clause whose keyword is `tokens[i]`, and the index after it; null (with
   * an error reported) when it's malformed. `source` is the string the tokens
   * were cut from.
   */
  private clause(
    tokens: Token[],
    i: number,
    lineNo: number,
    source: string
  ): { clause: Clause; next: number } | null {
    const spec = this.spec(tokens[i].text)
    i++
    if (this.seen.has(spec.name)) {
      this.error('duplicate_keyword', lineNo, spec.name)
      return null
    }
    this.seen.add(spec.name)

    const args: string[] = []
    for (const arg of spec.args) {
      if (arg.types.length === 1 && arg.types[0] === 'text') {
        if (i >= tokens.length) {
          this.error('missing_arg', lineNo, spec.name)
          return null
        }
        args.push(source.slice(tokens[i].start).trim())
        i = tokens.length
        continue
      }
      if (i >= tokens.length || this.isKnownKeyword(tokens[i])) {
        this.error('missing_arg', lineNo, spec.name)
        return null
      }
      if (!matchesValueType(tokens[i], arg.types)) {
        this.error('invalid_value', lineNo, tokens[i].text)
        return null
      }
      args.push(tokens[i].text)
      i++
    }

    const options: Record<string, string> = {}
    while (i < tokens.length && !tokens[i].quoted && spec.options.has(tokens[i].text)) {
      const name = tokens[i].text
      i++
      if (name in options) {
        this.error('duplicate_keyword', lineNo, name)
        return null
      }
      if (i >= tokens.length || this.isKnownKeyword(tokens[i])) {
        this.error('missing_arg', lineNo, name)
        return null
      }
      if (!matchesValueType(tokens[i], spec.options.get(name)!.types)) {
        this.error('invalid_value', lineNo, tokens[i].text)
        return null
      }
      options[name] = tokens[i].text
      i++
    }

    return { clause: { keyword: spec.name, line: lineNo, args, options }, next: i }
  }

  private spec(keyword: string): KeywordSpec {
    return this.schema.keywords.get(keyword)!
  }

  private isKnownKeyword(token: Token): boolean {
    return !token.quoted && this.schema.keywords.has(token.text)
  }

  private error(code: DiagnosticCode, line: number, detail: string): void {
    this.diagnostics.push({ code, line, detail })
  }
}
