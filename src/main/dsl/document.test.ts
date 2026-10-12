import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  clausesOf,
  isWarning,
  parseDocument,
  relationsOf,
  stateOf,
  unknownOf,
  type Clause,
  type Diagnostic,
  type Document
} from './document'
import { ITEM_SCHEMA } from './item-schema'

/** The sibling dsl repo's conformance cases (see its language.md, "Conformance"). */
const DSL_SPEC = join(__dirname, '../../../../dsl/spec')
const EXAMPLES = join(DSL_SPEC, 'examples')
const cases = existsSync(EXAMPLES)
  ? readdirSync(EXAMPLES)
      .filter((name) => name.endsWith('.txt'))
      .map((name) => name.slice(0, -'.txt'.length))
  : []

function clauseJson(clause: Clause): object {
  return { keyword: clause.keyword, line: clause.line, args: clause.args, options: clause.options }
}

function diagnosticsJson(diagnostics: Diagnostic[]): object[] {
  return diagnostics
    .map((diagnostic) => ({ code: diagnostic.code, line: diagnostic.line }))
    .sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || a.code.localeCompare(b.code))
}

function resultJson(doc: Document): Record<string, unknown> {
  return {
    body: doc.body.length > 0 ? doc.body.join('\n') : null,
    clauses: clausesOf(doc).map(clauseJson),
    relations: relationsOf(doc).map(({ label, target, line }) => ({ label, target, line })),
    state: stateOf(doc).map(clauseJson),
    unknown: unknownOf(doc),
    extra: doc.extra === null ? null : doc.extra.join('\n'),
    errors: diagnosticsJson(doc.diagnostics.filter((diagnostic) => !isWarning(diagnostic))),
    warnings: diagnosticsJson(doc.diagnostics.filter(isWarning))
  }
}

describe.skipIf(cases.length === 0)('dsl conformance examples', () => {
  it.each(cases)('%s', (name) => {
    const expected = JSON.parse(readFileSync(join(EXAMPLES, `${name}.json`), 'utf8'))
    const actual = resultJson(
      parseDocument(ITEM_SCHEMA, readFileSync(join(EXAMPLES, `${name}.txt`), 'utf8'))
    )
    const checked = Object.fromEntries(Object.keys(expected).map((key) => [key, actual[key]]))
    expect(checked).toEqual(expected)
  })
})

describe.skipIf(!existsSync(DSL_SPEC))('vendored schema', () => {
  it('matches the dsl repo (run `just sync-spec`)', () => {
    expect(readFileSync(join(__dirname, '../../../spec/keywords.yaml'), 'utf8')).toBe(
      readFileSync(join(DSL_SPEC, 'keywords.yaml'), 'utf8')
    )
  })
})
