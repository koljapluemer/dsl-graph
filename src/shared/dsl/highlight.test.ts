import { describe, expect, it } from 'vitest'
import { highlight, type Span } from './highlight'
import { ITEM_SCHEMA } from './item-schema'

function kinds(text: string): [string, Span['kind']][] {
  return highlight(ITEM_SCHEMA, text).map((span) => [text.slice(span.from, span.to), span.kind])
}

describe('highlight', () => {
  it('leaves the body alone and classifies section tokens', () => {
    expect(kinds('appointment w/ dentist\nrecurring mo until 27-03\nmedia "a b.png"')).toEqual([
      ['recurring', 'primary'],
      ['mo', 'value'],
      ['until', 'option'],
      ['27-03', 'value'],
      ['media', 'property'],
      ['"a b.png"', 'value']
    ])
  })

  it('marks tags, rest-of-line text, relations and blocks', () => {
    expect(
      kinds('x\ntags a media\ntasks fix appointment\n-> part of @y-1\nextra\nfree\ntext')
    ).toEqual([
      ['tags', 'property'],
      ['a', 'tag'],
      ['media', 'tag'],
      ['tasks', 'property'],
      ['fix', 'value'],
      ['appointment', 'value'],
      ['->', 'relation'],
      ['@y-1', 'target'],
      ['extra', 'blockMarker'],
      ['free\ntext', 'block']
    ])
  })

  it('marks an unknown keyword to the end of its line', () => {
    expect(kinds('x\nmedia a.png prio 3')).toEqual([
      ['media', 'property'],
      ['a.png', 'value'],
      ['prio 3', 'unknown']
    ])
  })
})
