import { parse } from 'yaml'

/**
 * The item language's keyword schema (`spec/keywords.yaml`, vendored from the
 * sibling `../dsl` repo). The parser reads it instead of naming keywords itself.
 */

export type Role = 'primary' | 'property' | 'modifier' | 'state'

export type ValueType = 'date' | 'month' | 'weekday' | 'path' | 'text' | 'tags'

/** `text` blocks are free text, `yaml` blocks a YAML mapping. */
export type BlockKind = 'text' | 'yaml'

const ROLES: readonly Role[] = ['primary', 'property', 'modifier', 'state']
const VALUE_TYPES: readonly ValueType[] = ['date', 'month', 'weekday', 'path', 'text', 'tags']
const BLOCK_KINDS: readonly BlockKind[] = ['text', 'yaml']

/** One positional argument, or the value of an option. Any of `types` is accepted. */
export interface ValueSpec {
  name: string
  types: ValueType[]
}

export interface KeywordSpec {
  name: string
  role: Role
  args: ValueSpec[]
  options: Map<string, ValueSpec>
  excludes: Set<string>
  /** Set for keywords that hold a multi-line block (see language.md, "Block keywords"). */
  block: BlockKind | null
  /** Must be the first token of its line (`line_start`). */
  lineStart: boolean
}

export interface Schema {
  version: number
  keywords: Map<string, KeywordSpec>
}

/** Whether a keyword of this role may start the keyword section at column 0. */
export function opensSection(role: Role): boolean {
  return role === 'primary' || role === 'property'
}

/** Throws when the yaml is malformed - that's a broken build, not a broken note. */
export function parseSchema(source: string): Schema {
  const root = parse(source) as { version?: unknown; keywords?: unknown }
  if (typeof root?.version !== 'number') {
    throw new Error('Schema has no version.')
  }
  if (!isRecord(root.keywords)) {
    throw new Error('Schema has no keywords.')
  }

  return {
    version: root.version,
    keywords: new Map(
      Object.entries(root.keywords).map(([name, spec]) => [name, parseKeyword(name, spec)])
    )
  }
}

function parseKeyword(name: string, raw: unknown): KeywordSpec {
  if (!isRecord(raw) || !ROLES.includes(raw.role as Role)) {
    throw new Error(`Keyword "${name}" has an invalid role.`)
  }

  const args = Array.isArray(raw.args) ? raw.args : []
  const options = isRecord(raw.options) ? raw.options : {}
  const excludes = Array.isArray(raw.excludes) ? raw.excludes : []
  if (raw.block !== undefined && !BLOCK_KINDS.includes(raw.block as BlockKind)) {
    throw new Error(`Keyword "${name}" has an invalid block.`)
  }

  return {
    name,
    role: raw.role as Role,
    args: args.map((arg) => ({ name: String(arg.name), types: parseTypes(name, arg.type) })),
    options: new Map(
      Object.entries(options).map(([option, spec]) => [
        option,
        { name: option, types: parseTypes(name, isRecord(spec) ? spec.type : undefined) }
      ])
    ),
    excludes: new Set(excludes.map(String)),
    block: (raw.block as BlockKind | undefined) ?? null,
    lineStart: raw.line_start === true
  }
}

/** `type: date` or `type: [date, month]`. */
function parseTypes(keyword: string, raw: unknown): ValueType[] {
  const names = Array.isArray(raw) ? raw : [raw]
  return names.map((name) => {
    if (!VALUE_TYPES.includes(name as ValueType)) {
      throw new Error(`Keyword "${keyword}" has an unknown type: ${String(name)}.`)
    }
    return name as ValueType
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
