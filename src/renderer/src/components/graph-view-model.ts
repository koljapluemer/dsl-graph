import type { Edge } from '@xyflow/react'
import type { ImageState } from './DraftNoteCard'
import type { GraphFlowNode } from './graph-flow-node'
import { mergeRelationsIntoEdges } from './graph-edges'
import { buildHiddenRelations } from './graph-hidden-relations'
import type { ConnectingInteraction, DraftInteraction, Interaction } from './graph-interaction'
import { NODE_CLASS_NAME } from './graph-node-style'
import { NODE_WIDTH, seedPosition, type GraphLayout } from '../lib/graph-layout'
import type { GraphEdgePayload, NoteGraph } from '../../../shared/notes'

// Draft/edit cards can grow past their layout slot while their content changes -
// keep them above everything else instead of trying to keep the layout from ever
// overlapping them.
const EDITING_NODE_Z_INDEX = 1000

export interface ViewCallbacks {
  onDeleteNote: (filename: string, pinDepth: number | null) => Promise<void>
  onStartEdit: (filename: string) => void
  onSaveEdit: (
    filename: string,
    text: string,
    image: ImageState,
    previousImage: string | null
  ) => Promise<void>
  onSaveDraft: (
    draft: DraftInteraction,
    body: string,
    label: string,
    reverse: boolean,
    image: ImageState
  ) => Promise<void>
  onCancelInteraction: () => void
  onConfirmConnection: (connecting: ConnectingInteraction, label: string) => Promise<void>
  onDeleteRelation: (relation: GraphEdgePayload) => Promise<void>
  onPinNote: (filename: string) => void
  onUnpinNote: (filename: string) => void
  onChangeDepth: (filename: string, nextDepth: number) => void
  onExpandHiddenRelations: (filename: string) => void
}

/**
 * The single place where the server-derived graph, the ELK layout, the current
 * pin state and the current in-progress interaction are merged into what
 * actually gets handed to <ReactFlow>. Kept as a pure function of its inputs so
 * this merge logic can be reasoned about independently of React's render cycle;
 * `useGraphNodes` runs it in an effect and reconciles the result into React
 * Flow's node state.
 *
 * `layout` is authoritative for every placed node's position - including ones
 * the user has dragged. Those are pinned and separated inside the layout layer
 * (see computeLayout / applyManualPositions), so there is nothing to override
 * here. A note with no slot yet is rendered invisibly at its seed position, only
 * so React Flow measures it - the layout places it once its height is known.
 * Relations and badges are drawn between placed notes only.
 *
 * The backend graph is authoritative for what notes/relations exist - there is
 * no client-side patch layer here, since a pinned note is a real BFS root on the
 * backend rather than an optimistic guess.
 */
export function buildView(
  graph: NoteGraph,
  layout: GraphLayout,
  pins: ReadonlyMap<string, number>,
  interaction: Interaction,
  anchorFilename: string | null,
  callbacks: ViewCallbacks
): { nodes: GraphFlowNode[]; edges: Edge[] } {
  const unplacedPosition = seedPosition(layout, anchorFilename) ?? { x: 0, y: 0 }

  const nodes: GraphFlowNode[] = graph.nodes.map((note) => {
    const slot = layout.slots.get(note.filename)
    // No `height` here - the card sizes to its own content (see .note-card in
    // main.css) and React Flow measures the real rendered height via its
    // internal ResizeObserver instead of us forcing one onto the DOM.
    // `slot.height` is the height ELK spaced this node's slot with.
    const shared = {
      id: note.filename,
      type: 'note' as const,
      position: slot?.position ?? unplacedPosition,
      width: slot?.width ?? NODE_WIDTH,
      className: slot ? NODE_CLASS_NAME : `${NODE_CLASS_NAME} invisible`
    }

    if (interaction.type === 'edit' && interaction.filename === note.filename) {
      return {
        ...shared,
        draggable: false,
        zIndex: EDITING_NODE_Z_INDEX,
        data: {
          kind: 'edit',
          initialText: interaction.text,
          initialImage: note.image,
          onSave: (text: string, image: ImageState) =>
            callbacks.onSaveEdit(note.filename, text, image, note.image),
          onCancel: callbacks.onCancelInteraction
        }
      }
    }

    return {
      ...shared,
      draggable: true,
      dragHandle: '.note-drag-handle',
      data: {
        kind: 'note',
        note,
        pinDepth: pins.get(note.filename) ?? null,
        isAnchor: note.filename === anchorFilename,
        onDelete: callbacks.onDeleteNote,
        onEdit: callbacks.onStartEdit,
        onPin: callbacks.onPinNote,
        onUnpin: callbacks.onUnpinNote,
        onChangeDepth: callbacks.onChangeDepth
      }
    }
  })

  const placedFilenames = new Set(layout.slots.keys())
  const positions = new Map([...layout.slots].map(([filename, slot]) => [filename, slot.position]))

  // Only relations between placed notes: an edge into a not-yet-placed (invisible)
  // card would point at its seed position. This also drops edges to a node the
  // backend cut after hitting its graph-size cap (the edge is registered before
  // its far endpoint's node-cap check runs), which has no slot either.
  const relations: GraphEdgePayload[] = graph.edges.filter(
    (edge) => placedFilenames.has(edge.source) && placedFilenames.has(edge.target)
  )

  const edges: Edge[] = mergeRelationsIntoEdges(relations, positions).map((edge) => ({
    ...edge,
    data: {
      ...(edge.data as Record<string, unknown> | undefined),
      onDeleteRelation: callbacks.onDeleteRelation
    }
  }))

  if (interaction.type === 'draft') {
    nodes.push({
      id: interaction.clientId,
      type: 'note',
      position: interaction.position,
      width: NODE_WIDTH,
      draggable: false,
      className: NODE_CLASS_NAME,
      zIndex: EDITING_NODE_Z_INDEX,
      data: {
        kind: 'draft',
        showRelation: interaction.sourceFilename !== null,
        onSave: (body, label, reverse, image) =>
          callbacks.onSaveDraft(interaction, body, label, reverse, image),
        onCancel: callbacks.onCancelInteraction
      }
    })

    // The source note may have been deleted while this draft was still open - the
    // draft card itself still works (it just won't create a relation on save), but
    // don't draw a preview line to a node that no longer exists.
    if (interaction.sourceFilename && placedFilenames.has(interaction.sourceFilename)) {
      edges.push({
        id: `${interaction.clientId}__preview`,
        source: interaction.sourceFilename,
        target: interaction.clientId,
        type: 'floating',
        style: { strokeWidth: 1.4, strokeDasharray: '4 4' }
      })
    }
  }

  if (interaction.type === 'connecting') {
    // Same defensive check: either note may have been deleted while this
    // confirm-the-label popover was still open.
    if (placedFilenames.has(interaction.source) && placedFilenames.has(interaction.target)) {
      edges.push({
        id: `pending:${interaction.source}->${interaction.target}`,
        source: interaction.source,
        target: interaction.target,
        type: 'pendingConnection',
        data: {
          onConfirm: (label: string) => callbacks.onConfirmConnection(interaction, label),
          onCancel: callbacks.onCancelInteraction
        }
      })
    }
  }

  // Appended last: React Flow needs a child node (the badge) after its parent in
  // the array, and every parent note is already in `nodes` by now.
  const hiddenRelations = buildHiddenRelations(
    graph,
    layout,
    pins,
    interaction.type === 'edit' ? interaction.filename : null,
    callbacks.onExpandHiddenRelations
  )

  return {
    nodes: [...nodes, ...hiddenRelations.nodes],
    edges: [...edges, ...hiddenRelations.edges]
  }
}
