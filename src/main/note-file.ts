import { clausesOf, relationsOf, type Clause, type Document } from './dsl/document'
import { clauseLine, isValidRelationTarget, relationLine, textLines } from './dsl/serialize'
import { NOTE_EXTENSION } from './graph-fs'
import type { NoteLink } from '../shared/notes'

/**
 * graphirst's view of an item file (see `../dsl/spec/language.md`): the body,
 * the extra content, `-> label @target` relationships and the `media` line.
 * Every other line of the file is left as it was.
 */

/** Shown for, and written as, a relationship without a label. */
export const UNLABELED_RELATION = 'related'

const MEDIA_KEYWORD = 'media'

export interface NoteContent {
  body: string
  rels: NoteLink[]
  extraContent: string
  /** Path of the attached image or video, relative to the graph folder. */
  media: string | null
}

export function noteFilename(stem: string): string {
  return `${stem}${NOTE_EXTENSION}`
}

/** `foo.txt` -> `foo`: the name other notes use to point at it. */
export function noteStem(filename: string): string {
  return filename.endsWith(NOTE_EXTENSION) ? filename.slice(0, -NOTE_EXTENSION.length) : filename
}

export function readNoteContent(doc: Document): NoteContent {
  return {
    body: doc.body.join('\n'),
    rels: relationsOf(doc).map((relation) => ({
      label: relation.label || UNLABELED_RELATION,
      target: noteFilename(relation.target)
    })),
    extraContent: doc.extra?.join('\n') ?? '',
    media: clausesOf(doc).find((clause) => clause.keyword === MEDIA_KEYWORD)?.args[0] ?? null
  }
}

export function newNoteDocument(body: string): Document {
  return { body: textLines(body), section: [], extra: null, diagnostics: [] }
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
