import {
  NOTE_LIST_PAGE_SIZE,
  type IndexedNote,
  type RecentNote,
  type RecentNotesResponse
} from '../shared/notes'
import { buildNotePreview } from './note-preview'

/** Newest first; equal mtimes fall back to filename so the order is stable across refreshes. */
function compareRecency(a: IndexedNote, b: IndexedNote): number {
  if (a.mtimeMs !== b.mtimeMs) {
    return b.mtimeMs - a.mtimeMs
  }
  return a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0
}

/** Index at which `candidate` belongs in `ranked` (already ordered by compareRecency). */
function findInsertionIndex(ranked: IndexedNote[], candidate: IndexedNote): number {
  let low = 0
  let high = ranked.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (compareRecency(ranked[middle], candidate) <= 0) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return low
}

function toRecentNote(note: IndexedNote): RecentNote {
  return { filename: note.filename, preview: buildNotePreview(note) }
}

/**
 * One page of notes by file modification time, newest first, plus the total
 * count. One pass over the index keeping a ranking bounded to the end of the
 * requested page, so cost stays O(n log k) with no full sort, and previews are
 * built for the returned page only.
 */
export function selectRecentNotes(notes: Iterable<IndexedNote>, page: number): RecentNotesResponse {
  const start = page * NOTE_LIST_PAGE_SIZE
  const bound = start + NOTE_LIST_PAGE_SIZE
  const ranked: IndexedNote[] = []
  let total = 0

  for (const note of notes) {
    total += 1
    const index = findInsertionIndex(ranked, note)
    if (index >= bound) {
      continue
    }

    ranked.splice(index, 0, note)
    if (ranked.length > bound) {
      ranked.pop()
    }
  }

  return { results: ranked.slice(start).map(toRecentNote), total }
}
