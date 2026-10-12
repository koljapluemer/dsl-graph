import { describe, expect, it } from 'vitest'
import { errorsOf, parseDocument, type Document } from './dsl/document'
import { ITEM_SCHEMA } from './dsl/item-schema'
import { serializeDocument } from './dsl/serialize'
import {
  addRelation,
  newNoteDocument,
  readNoteContent,
  relabelRelation,
  removeRelation,
  setBody,
  setExtra,
  setMedia
} from './note-file'

function parse(text: string): Document {
  const doc = parseDocument(ITEM_SCHEMA, text)
  expect(errorsOf(doc)).toEqual([])
  return doc
}

function edit(text: string, change: (doc: Document) => void): string {
  const doc = parse(text)
  change(doc)
  return serializeDocument(ITEM_SCHEMA, doc)
}

describe('note files', () => {
  it('writes a new note as just its body', () => {
    expect(serializeDocument(ITEM_SCHEMA, newNoteDocument('Buy milk\n\nand eggs\n\n'))).toBe(
      'Buy milk\n\nand eggs\n'
    )
  })

  it('reads body, relations, extra and media', () => {
    const content = readNoteContent(
      parse(
        'Buy milk\nsecond line\n\nmedia images/buy-milk-a1b2c3-1.webp\n-> for @recipe-abc123\n-> @loose-0a0a0a\nextra\nDetails'
      )
    )
    expect(content).toEqual({
      body: 'Buy milk\nsecond line',
      rels: [
        { label: 'for', target: 'recipe-abc123.txt' },
        { label: 'related', target: 'loose-0a0a0a.txt' }
      ],
      extraContent: 'Details',
      media: 'images/buy-milk-a1b2c3-1.webp'
    })
  })

  it('keeps lines it does not own when editing', () => {
    const text = [
      'Lecture',
      '',
      'recurring mo until 27-03',
      'iterable d 4 0.4',
      '(lastgenerated 26-10-11)',
      '-> part of @semester-ab12cd',
      'extra',
      'Room D139'
    ].join('\n')
    expect(edit(text, (doc) => setBody(doc, 'Lecture, moved'))).toBe(
      text.replace('Lecture\n', 'Lecture, moved\n') + '\n'
    )
  })

  it('round-trips a file it did not change', () => {
    const text = 'A\n\n-> b @c-123456\n(foo bar)\nextra\nx\n'
    expect(edit(text, () => {})).toBe(text)
  })

  it('indents body lines that would start the keyword section', () => {
    const written = edit('x', (doc) =>
      setBody(doc, 'first\n-> looks like @a-relation\nextra\nmedia a.png\nrecurring mo\nplain')
    )
    expect(written).toBe(
      'first\n -> looks like @a-relation\n extra\n media a.png\n recurring mo\nplain\n'
    )
    expect(readNoteContent(parse(written)).rels).toEqual([])
  })

  it('never escapes the first line', () => {
    expect(edit('x', (doc) => setBody(doc, 'recurring thoughts'))).toBe('recurring thoughts\n')
  })

  it('refuses an empty body', () => {
    expect(() => edit('x', (doc) => setBody(doc, '  \n'))).toThrow()
  })

  it('sets and removes extra content', () => {
    const withExtra = edit('x\n-> a @b-123456', (doc) => setExtra(doc, '\nlong\n-> text @c-1\n\n'))
    expect(withExtra).toBe('x\n\n-> a @b-123456\nextra\nlong\n-> text @c-1\n')
    expect(edit(withExtra, (doc) => setExtra(doc, ' '))).toBe('x\n\n-> a @b-123456\n')
  })

  it('adds, relabels and removes relationships', () => {
    const added = edit('x', (doc) =>
      addRelation(doc, { label: 'is part of', target: 'y-123456.txt' })
    )
    expect(added).toBe('x\n\n-> is part of @y-123456\n')

    const relabeled = edit(added, (doc) =>
      relabelRelation(doc, { label: 'is part of', target: 'y-123456.txt' }, 'clarifies')
    )
    expect(relabeled).toBe('x\n\n-> clarifies @y-123456\n')

    expect(
      edit(relabeled, (doc) => removeRelation(doc, { label: 'clarifies', target: 'y-123456.txt' }))
    ).toBe('x\n')
  })

  it('matches an unlabeled relationship by its shown label', () => {
    expect(
      edit('x\n-> @y-123456', (doc) =>
        removeRelation(doc, { label: 'related', target: 'y-123456.txt' })
      )
    ).toBe('x\n')
  })

  it('refuses a relationship target that cannot be written', () => {
    expect(() =>
      edit('x', (doc) => addRelation(doc, { label: 'a', target: 'has space.txt' }))
    ).toThrow()
  })

  it('sets, replaces and clears media', () => {
    const attached = edit('x\n-> a @b-123456', (doc) => setMedia(doc, 'images/x 1.webp'))
    expect(attached).toBe('x\n\nmedia "images/x 1.webp"\n-> a @b-123456\n')
    expect(readNoteContent(parse(attached)).media).toBe('images/x 1.webp')

    const replaced = edit(attached, (doc) => setMedia(doc, 'images/x-2.mp4'))
    expect(replaced).toBe('x\n\nmedia images/x-2.mp4\n-> a @b-123456\n')

    expect(edit(replaced, (doc) => setMedia(doc, null))).toBe('x\n\n-> a @b-123456\n')
  })

  it('keeps other clauses sharing the media line', () => {
    expect(edit('x\nappointment 26-10-12 media a.png', (doc) => setMedia(doc, null))).toBe(
      'x\n\nappointment 26-10-12\n'
    )
  })
})
