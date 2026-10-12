import { useStore, type ReactFlowState, type XYPosition } from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import {
  applyManualPositions,
  collectMeasuredHeights,
  computeLayout,
  EMPTY_LAYOUT,
  isLayoutCurrent,
  layoutStructureKey,
  resolveLayoutHeights,
  samePositions,
  type GraphLayout
} from '../lib/graph-layout'
import type { NoteGraph } from '../../../shared/notes'

const selectMeasuredHeights = (state: ReactFlowState): Map<string, number> =>
  collectMeasuredHeights(state.nodeLookup.values())

function sameHeights(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) {
    return false
  }
  for (const [id, height] of a) {
    if (b.get(id) !== height) {
      return false
    }
  }
  return true
}

/** A layout plus whether it moved notes enough that the viewport should reframe. */
export interface LayoutCommit {
  layout: GraphLayout
  reframe: boolean
}

export interface UseElkLayoutParams {
  graph: NoteGraph
  pins: ReadonlyMap<string, number>
  /** The note being edited - its card grows as it is typed into, so its slot height is frozen meanwhile. */
  frozenFilename: string | null
  /** Notes the user has dragged: pinned in the layout and the drop patch below. */
  manualPositionsRef: RefObject<Map<string, XYPosition>>
  /** True for the duration of a node drag - layout is suspended so a drag never fights ELK. */
  dragging: boolean
}

export interface UseElkLayoutResult {
  committed: LayoutCommit
  /** The note new/disconnected nodes are seeded next to. Drives NoteCard's dashed border. */
  anchorFilename: string | null
  /** Records that a note was just pinned/created/acted-on, so it becomes the next layout anchor. */
  markInteraction: (filename: string) => void
  /**
   * Re-applies every manual position to the current layout and re-opens space
   * around them - no ELK run. Called on drop so the released card keeps its exact
   * spot while its neighbours shift out of the way.
   */
  applyManualDrop: () => void
}

/**
 * Owns the layout lifecycle: measure first, then lay out once.
 *
 * A note without a slot is rendered invisibly (see buildView) so React Flow can
 * measure it. ELK runs only once every note has a height, and only when the
 * current layout does not already account for the graph's structure and those
 * heights - so a content-only change (an `extra` edit) never moves
 * anything. Plus the "seed new nodes next to the note that was just acted on"
 * anchoring and `applyManualDrop` for the on-drop separation. Suspended while a
 * node is being dragged.
 */
export function useElkLayout({
  graph,
  pins,
  frozenFilename,
  manualPositionsRef,
  dragging
}: UseElkLayoutParams): UseElkLayoutResult {
  const allMeasuredHeights = useStore(selectMeasuredHeights, sameHeights)
  const measuredHeights = useMemo(() => {
    if (!frozenFilename || !allMeasuredHeights.has(frozenFilename)) {
      return allMeasuredHeights
    }
    const withoutFrozen = new Map(allMeasuredHeights)
    withoutFrozen.delete(frozenFilename)
    return withoutFrozen
  }, [allMeasuredHeights, frozenFilename])
  const structure = useMemo(() => layoutStructureKey(graph), [graph])

  const [committed, setCommitted] = useState<LayoutCommit>({
    layout: EMPTY_LAYOUT,
    reframe: false
  })
  const { layout } = committed

  // The note new/disconnected nodes are seeded next to. The most recently
  // acted-on note stays pending until it has a slot of its own, so a fresh pin
  // never ends up seeded from itself. Promoted during render (React's "adjust
  // state when a prop changes" pattern), not in an effect.
  const [anchorFilename, setAnchorFilename] = useState<string | null>(null)
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null)
  if (pendingAnchor && layout.slots.has(pendingAnchor)) {
    setAnchorFilename(pendingAnchor)
    setPendingAnchor(null)
  }
  const previousPinsRef = useRef<ReadonlyMap<string, number>>(new Map())

  const markInteraction = useCallback((filename: string) => {
    setPendingAnchor(filename)
  }, [])

  useEffect(() => {
    for (const filename of pins.keys()) {
      if (!previousPinsRef.current.has(filename)) {
        markInteraction(filename)
      }
    }
    previousPinsRef.current = pins
  }, [pins, markInteraction])

  const applyManualDrop = useCallback(() => {
    setCommitted((current) => ({
      layout: applyManualPositions(current.layout, manualPositionsRef.current),
      reframe: false
    }))
  }, [manualPositionsRef])

  // The single layout pass. Re-runs on every input change, including its own
  // commit - which `isLayoutCurrent` then turns into a no-op. An input change
  // mid-run cancels the stale result.
  useEffect(() => {
    if (dragging) {
      return
    }
    const heights = resolveLayoutHeights(graph, measuredHeights, layout)
    if (!heights || isLayoutCurrent(layout, structure, heights)) {
      return
    }

    let cancelled = false

    computeLayout(graph, heights, layout, anchorFilename, manualPositionsRef.current)
      .then((next) => {
        if (cancelled) {
          return
        }
        setCommitted({
          layout: next,
          reframe: next.slots.size > 0 && !samePositions(layout, next)
        })
      })
      .catch((error: unknown) => {
        // Never fail silently: a rejection here would otherwise leave the layout
        // frozen with no visible sign anything had gone wrong.
        console.error('Failed to lay out graph:', error)
      })

    return () => {
      cancelled = true
    }
  }, [graph, structure, measuredHeights, layout, anchorFilename, dragging, manualPositionsRef])

  return { committed, anchorFilename, markInteraction, applyManualDrop }
}
