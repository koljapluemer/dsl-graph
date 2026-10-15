import { clausesOf, relationsOf, type Clause, type Document } from '../shared/dsl/document'
import { ITEM_SCHEMA } from '../shared/dsl/item-schema'
import { clauseLine, isValidRelationTarget, relationLine, textLines } from '../shared/dsl/serialize'
import { NOTE_EXTENSION } from './graph-fs'
import type { NoteLink } from '../shared/notes'

/**
 * graphirst's view of an item file (see `../dsl/spec/language.md`): the body,
 * the extra content, `-> label @target` relationships and the `media` line it
 * edits, plus what it only shows or filters by (other keyword lines, `data`,
 * the type and the tags). Every other line of the file is left as it was.
 */

/** Shown for, and written as, a relationship without a label. */
export const UNLABELED_RELATION = 'related'

const MEDIA_KEYWORD = 'media'
const TAGS_KEYWORD = 'tags'

/**
 * Keywords whose lines a card doesn't show: `media` is the preview already,
 * `tags` only matter for filtering.
 */
const BORING_KEYWORDS: ReadonlySet<string> = new Set([MEDIA_KEYWORD, TAGS_KEYWORD])

export interface NoteContent {
  body: string
  rels: NoteLink[]
  extraContent: string
  /** Path of the attached image or video, relative to the graph folder. */
  media: string | null
  /** The first `primary` keyword, or null for a plain note. */
  type: string | null
  tags: string[]
  /** Keyword lines worth showing on a card, verbatim: no boring, relationship or state lines. */
  sectionLines: string[]
  /** The `data` block's lines joined, or null when there is none. */
  dataText: string | null
}

export function noteFilename(stem: string): string {
  return `${stem}${NOTE_EXTENSION}`
}

/** `foo.txt` -> `foo`: the name other notes use to point at it. */
export function noteStem(filename: string): string {
  return filename.endsWith(NOTE_EXTENSION) ? filename.slice(0, -NOTE_EXTENSION.length) : filename
}

export function readNoteContent(doc: Document): NoteContent {
  const clauses = clausesOf(doc)
  return {
    body: doc.body.join('\n'),
    rels: relationsOf(doc).map((relation) => ({
      label: relation.label || UNLABELED_RELATION,
      target: noteFilename(relation.target)
    })),
    extraContent: doc.extra?.join('\n') ?? '',
    media: clauses.find((clause) => clause.keyword === MEDIA_KEYWORD)?.args[0] ?? null,
    type:
      clauses.find((clause) => ITEM_SCHEMA.keywords.get(clause.keyword)?.role === 'primary')
        ?.keyword ?? null,
    tags: clauses.find((clause) => clause.keyword === TAGS_KEYWORD)?.args ?? [],
    sectionLines: doc.section.flatMap((line) =>
      line.kind === 'clauses' &&
      !(line.unknownTail === null && line.clauses.every((c) => BORING_KEYWORDS.has(c.keyword)))
        ? [line.raw]
        : []
    ),
    dataText: doc.data?.join('\n') ?? null
  }
}

export function newNoteDocument(body: string): Document {
  return { body: textLines(body), section: [], extra: null, data: null, diagnostics: [] }
}

export function setBody(doc: Document, body: string): void {
  doc.body = textLines(body)
}

/** Blank `extra` removes the extra block. */
export function setExtra(doc: Document, extra: string): void {
  const lines = textLines(extra)
  doc.extra = lines.length > 0 ? lines : null
}

export function addRelation(doc: Document, link: NoteLink): void {
  const target = noteStem(link.target)
  if (!isValidRelationTarget(target)) {
    throw new Error(`"${link.target}" can't be the target of a relationship.`)
  }
  doc.section.push(relationLine(link.label, target))
}

/** Removes the first relationship matching `link`; throws when there is none. */
export function removeRelation(doc: Document, link: NoteLink): void {
  doc.section.splice(findRelationLine(doc, link), 1)
}

export function relabelRelation(doc: Document, link: NoteLink, nextLabel: string): void {
  doc.section[findRelationLine(doc, link)] = relationLine(nextLabel, noteStem(link.target))
}

function findRelationLine(doc: Document, link: NoteLink): number {
  const index = doc.section.findIndex(
    (line) =>
      line.kind === 'relation' &&
      line.relation !== null &&
      (line.relation.label || UNLABELED_RELATION) === link.label &&
      noteFilename(line.relation.target) === link.target
  )
  if (index === -1) {
    throw new Error('Could not find that relationship.')
  }
  return index
}

/** Points the `media` line at `path`, or removes it for null. Other clauses on its line stay. */
export function setMedia(doc: Document, path: string | null): void {
  const media: Clause = { keyword: MEDIA_KEYWORD, line: 0, args: [path ?? ''], options: {} }
  const index = doc.section.findIndex(
    (line) =>
      line.kind === 'clauses' && line.clauses.some((clause) => clause.keyword === MEDIA_KEYWORD)
  )

  if (index === -1) {
    if (path !== null) {
      doc.section.unshift(clauseLine([media]))
    }
    return
  }

  const line = doc.section[index]
  if (line.kind !== 'clauses') {
    return
  }
  const clauses = line.clauses.flatMap((clause) =>
    clause.keyword !== MEDIA_KEYWORD ? [clause] : path === null ? [] : [media]
  )
  if (clauses.length === 0 && line.unknownTail === null) {
    doc.section.splice(index, 1)
  } else {
    doc.section[index] = clauseLine(clauses, line.unknownTail)
  }
}
