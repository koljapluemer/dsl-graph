import { isTag } from '../shared/dsl/values'
import type { Blacklist } from '../shared/notes'

export const EMPTY_BLACKLIST: Blacklist = { types: [], tags: [] }

/**
 * A stored or requested blacklist, validated: unknown shapes become empty, tags
 * that aren't valid tags are dropped, and both lists are de-duplicated and sorted.
 */
export function parseBlacklist(raw: unknown): Blacklist {
  if (typeof raw !== 'object' || raw === null) {
    return EMPTY_BLACKLIST
  }
  const { types, tags } = raw as Record<string, unknown>
  return {
    types: sortedStrings(types).filter((type) => /^[a-z]+$/.test(type)),
    tags: sortedStrings(tags).filter(isTag)
  }
}

/** Whether a note of `type` carrying `tags` is ignored under `blacklist`. */
export function hides(blacklist: Blacklist, type: string | null, tags: string[]): boolean {
  return (
    (type !== null && blacklist.types.includes(type)) ||
    tags.some((tag) => blacklist.tags.includes(tag))
  )
}

function sortedStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return [...new Set(value.filter((item): item is string => typeof item === 'string'))].sort()
}
