import { startTransition, useCallback, useEffect, useRef, useState } from 'react'
import { replaceEqualDeep } from '../lib/replace-equal-deep'
import type { NoteGraph, PinSpec } from '../../../shared/notes'

export const MANUAL_PIN_DEPTH = 1
export const SEARCH_RESULT_PIN_DEPTH = 2
export const CREATED_NOTE_PIN_DEPTH = 1
/** "Pin all" from search pins roots only, so a broad query doesn't flood the graph with neighbors. */
export const PIN_ALL_DEPTH = 0
export const PIN_ALL_CAP = 100

const EMPTY_GRAPH: NoteGraph = { nodes: [], edges: [], truncated: false, warnings: [] }

export interface UseNoteGraphResult {
  graph: NoteGraph | null
  pins: ReadonlyMap<string, number>
  loading: boolean
  error: string | null
  pinNote: (filename: string, depth: number) => void
  pinNotes: (filenames: readonly string[], depth: number) => void
  unpinNote: (filename: string) => void
  setPinDepth: (filename: string, depth: number) => void
  /** Pins `filename` at `depth` unless it is already pinned at least that deep. */
  pinAtLeast: (filename: string, depth: number) => void
  clearPins: () => void
  /** `background: true` refreshes the graph without showing the loading overlay - for silent "notes changed on disk" refetches. */
  refetch: (opts?: { background?: boolean }) => void
}

/**
 * Owns the pinned-note set and the graph fetched for it. The pinned set is the real
 * input to the backend's graph query (see note-store.ts buildGraph) - there is no
 * client-side patch layer on top, unlike the old single-center model.
 */
export function useNoteGraph(): UseNoteGraphResult {
  const [pins, setPins] = useState<Map<string, number>>(new Map())
  const [graph, setGraph] = useState<NoteGraph | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refetchNonce, setRefetchNonce] = useState(0)
  const requestIdRef = useRef(0)
  const backgroundRef = useRef(false)
  const hadPinsRef = useRef(false)

  useEffect(() => {
    let ignore = false
    const requestId = ++requestIdRef.current
    const isBackground = backgroundRef.current
    backgroundRef.current = false

    const run = async (): Promise<void> => {
      if (pins.size === 0) {
        setGraph(EMPTY_GRAPH)
        // On the transition from some pins to none, still tell the backend the
        // set is now empty (no graph fetch needed) so the pin set it persists
        // for the next start stays accurate.
        if (hadPinsRef.current) {
          hadPinsRef.current = false
          void window.api.notes.openGraph([]).catch(() => {})
        }
        return
      }
      hadPinsRef.current = true

      if (!isBackground) {
        setLoading(true)
      }
      try {
        const response = await window.api.notes.openGraph(toPinSpecs(pins))
        if (ignore || requestId !== requestIdRef.current) {
          return
        }
        // Structural sharing: unchanged notes/relations keep their identity, and
        // a refetch that changed nothing keeps the whole graph - so everything
        // downstream (layout, node view, memoized cards) sees only real changes.
        startTransition(() => {
          setGraph((prev) => (prev ? replaceEqualDeep(prev, response.graph) : response.graph))
        })
        setError(null)
      } catch (err) {
        if (ignore || requestId !== requestIdRef.current) {
          return
        }
        setError((err as Error).message)
      } finally {
        if (!ignore && requestId === requestIdRef.current) {
          setLoading(false)
        }
      }
    }

    void run()

    return () => {
      ignore = true
    }
  }, [pins, refetchNonce])

  const pinNote = useCallback((filename: string, depth: number) => {
    setPins((prev) => (prev.has(filename) ? prev : new Map(prev).set(filename, depth)))
  }, [])

  const pinNotes = useCallback((filenames: readonly string[], depth: number) => {
    setPins((prev) => {
      const missing = filenames.filter((filename) => !prev.has(filename))
      if (missing.length === 0) {
        return prev
      }
      const next = new Map(prev)
      for (const filename of missing) {
        next.set(filename, depth)
      }
      return next
    })
  }, [])

  const unpinNote = useCallback((filename: string) => {
    setPins((prev) => {
      if (!prev.has(filename)) {
        return prev
      }
      const next = new Map(prev)
      next.delete(filename)
      return next
    })
  }, [])

  const setPinDepth = useCallback((filename: string, depth: number) => {
    const clamped = Math.max(0, depth)
    setPins((prev) => (prev.has(filename) ? new Map(prev).set(filename, clamped) : prev))
  }, [])

  const pinAtLeast = useCallback((filename: string, depth: number) => {
    setPins((prev) => {
      const current = prev.get(filename)
      return current !== undefined && current >= depth ? prev : new Map(prev).set(filename, depth)
    })
  }, [])

  const clearPins = useCallback(() => setPins(new Map()), [])
  const refetch = useCallback((opts?: { background?: boolean }) => {
    backgroundRef.current = opts?.background ?? false
    setRefetchNonce((n) => n + 1)
  }, [])

  return {
    graph,
    pins,
    loading,
    error,
    pinNote,
    pinNotes,
    unpinNote,
    setPinDepth,
    pinAtLeast,
    clearPins,
    refetch
  }
}

function toPinSpecs(pins: Map<string, number>): PinSpec[] {
  return Array.from(pins, ([filename, depth]) => ({ filename, depth }))
}
