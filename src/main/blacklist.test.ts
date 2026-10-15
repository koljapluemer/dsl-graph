import { describe, expect, it } from 'vitest'
import { hides, parseBlacklist } from './blacklist'

describe('blacklist', () => {
  it('hides by type or by any tag', () => {
    const blacklist = { types: ['appointment'], tags: ['break'] }
    expect(hides(blacklist, 'appointment', [])).toBe(true)
    expect(hides(blacklist, null, ['x', 'break'])).toBe(true)
    expect(hides(blacklist, 'recurring', ['x'])).toBe(false)
    expect(hides(blacklist, null, [])).toBe(false)
  })

  it('validates what it is given', () => {
    expect(parseBlacklist(undefined)).toEqual({ types: [], tags: [] })
    expect(
      parseBlacklist({ types: ['source', 'source', 3, 'Bad'], tags: ['b', 'a', 'No', 'a-1'] })
    ).toEqual({ types: ['source'], tags: ['a', 'a-1', 'b'] })
  })
})
