import { startTransition, useEffect, useRef, useState } from 'react'
import type { RecentNote } from '../../../shared/notes'

export interface UseRecentNotesResult {
  results: RecentNote[]
  /** Every note, across all pages. */
  total: number
  loading: boolean
}

/**
 * One page of the most recently modified notes. Re-queries on any backend note
 * change (see notes.onChanged), so creating or editing a note reorders the list
 * without the caller doing anything.
 */
export function useRecentNotes(
  page: number,
  onError?: (error: Error) => void
): UseRecentNotesResult {
  const [results, setResults] = useState<RecentNote[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [changeNonce, setChangeNonce] = useState(0)
  const onErrorRef = useRef(onError)
  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  useEffect(() => window.api.notes.onChanged(() => setChangeNonce((n) => n + 1)), [])

  useEffect(() => {
    let ignore = false

    const loadRecent = async (): Promise<void> => {
      setLoading(true)
      try {
        const response = await window.api.notes.recentNotes({ page })
        if (!ignore) {
          startTransition(() => {
            setResults(response.results)
            setTotal(response.total)
          })
        }
      } catch (error) {
        if (!ignore) {
          onErrorRef.current?.(error as Error)
        }
      } finally {
        if (!ignore) {
          setLoading(false)
        }
      }
    }

    void loadRecent()

    return () => {
      ignore = true
    }
  }, [page, changeNonce])

  return { results, total, loading }
}
