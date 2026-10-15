import type { InternalNode, XYPosition } from '@xyflow/react'

/**
 * What the user is currently doing on the canvas, beyond just looking at it.
 * A single union (rather than separate booleans/slots per gesture) makes the
 * mutually-exclusive states structurally mutually exclusive - you can't have a
 * draft note AND a pending connection open at once, because there is only one
 * `interaction` value.
 */
export type Interaction =
  IdleInteraction | DraftInteraction | ConnectingInteraction | EditInteraction | SearchInteraction

export interface IdleInteraction {
  type: 'idle'
}

export interface DraftInteraction {
  type: 'draft'
  clientId: string
  /** Note this draft will be connected from, or null for a freestanding/unconnected note. */
  sourceFilename: string | null
  position: XYPosition
}

export interface ConnectingInteraction {
  type: 'connecting'
  source: string
  target: string
}

export interface EditInteraction {
  type: 'edit'
  filename: string
  /** The note file's full text when editing started. */
  text: string
}

export interface SearchInteraction {
  type: 'search'
  /** Viewport (clientX/clientY) coordinates of the right-click that opened this menu. */
  screenPosition: { x: number; y: number }
}

export const IDLE_INTERACTION: Interaction = { type: 'idle' }

/** Draft/edit client ids are prefixed so the layout/drag layers can skip them. */
export const DRAFT_ID_PREFIX = 'draft:'

/**
 * The note a connection drag ended on, or null when it didn't end on one.
 * React Flow resolves the drop to the nearest handle within `connectionRadius`
 * even if that handle isn't connectable, so the node it reports can be a draft
 * card (never a target) or a hidden-relations badge - which sits right under its
 * note, so a drop that lands on it means that note.
 */
export function connectionTargetFilename(toNode: InternalNode | null): string | null {
  if (!toNode) {
    return null
  }
  if (toNode.type === 'hiddenRelations') {
    return toNode.parentId ?? null
  }
  return toNode.id.startsWith(DRAFT_ID_PREFIX) ? null : toNode.id
}
