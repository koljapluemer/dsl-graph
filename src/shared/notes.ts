export type NoteRelationTuple = [label: string, target: string]

export interface RawNoteFile {
  body?: string
  rels?: NoteRelationTuple[]
  /**
   * Long-form content for this note. Shared verbatim with the sibling `../note`
   * app, which owns this key. An attached image or video is NOT referenced here -
   * it is a loose file in the graph folder's `images/` subdirectory, matched to
   * this note by filename stem (see NoteStore.imagesByStem).
   */
  extra?: string
  /** Freeform comments/to-dos attached to this note, rendered on the node itself. */
  notes?: string[]
  /** ISO-8601 timestamp, written once when this app first creates the note. Implies `updated` and `opened` at that same instant. */
  created?: string
  /** ISO-8601 timestamp of the last content edit (body, extra content, or a freeform note entry). Any `updated` also refreshes `opened`. */
  updated?: string
  /** ISO-8601 timestamp this note was last opened on the graph - pinned onto it, created, or edited. */
  opened?: string
  /** ISO-8601 timestamp of the last change to this note's relationships, incoming or outgoing (a target added or removed, or a label changed). */
  relationshipsChanged?: string
}

export interface NoteLink {
  label: string
  target: string
}

export interface IndexedNote {
  filename: string
  body: string
  /** Whitespace-compacted body, computed once at index time and reused by preview building and raw/regex search instead of recompacting per query. */
  bodyCompact: string
  rels: NoteLink[]
  degree: number
  /** Filename (inside the graph folder's `images/` subdirectory) of the image or video matched to this note by stem, or null. */
  image: string | null
  extraContent: string
  /** Whitespace-compacted extra content, the extra-content counterpart to bodyCompact (search now scans this too). */
  extraCompact: string
  notes: string[]
  /** ISO-8601 lifecycle timestamps (see RawNoteFile). Null until this app has stamped the corresponding event. */
  created: string | null
  updated: string | null
  opened: string | null
  relationshipsChanged: string | null
}

export interface PinSpec {
  filename: string
  depth: number
}

export interface GraphNodePayload {
  filename: string
  body: string
  image: string | null
  extraContent: string
  /** Hops from the nearest pin that discovered this node. Informational only. */
  depth: number
  degree: number
  /** Distinct renderable notes related to this one (either direction) that are not on the canvas - what pinning it at depth 1 would bring in. */
  hiddenNeighbors: number
  notes: string[]
  /** ISO-8601 lifecycle timestamps (see RawNoteFile). Null until this app has stamped the corresponding event. */
  created: string | null
  updated: string | null
  opened: string | null
  relationshipsChanged: string | null
}

export interface GraphEdgePayload {
  id: string
  source: string
  target: string
  label: string
  depth: number
  direction: 'incoming' | 'outgoing'
}

export interface NoteGraph {
  nodes: GraphNodePayload[]
  edges: GraphEdgePayload[]
  truncated: boolean
  warnings: string[]
}

/** A span of text, as UTF-16 offsets into the string it refers to. */
export interface MatchRange {
  start: number
  length: number
}

/** A short stretch of a note's text around a match, for when the match isn't in the card's preview. */
export interface SearchExcerpt {
  text: string
  match: MatchRange
}

export interface SearchResult {
  filename: string
  /** The note's opening text, same as the recent-notes list. */
  preview: string
  /** Where the match sits within `preview`; null when it isn't visible there. */
  previewMatch: MatchRange | null
  /** Excerpt around the match; set exactly when the match is not visible in `preview`. */
  excerpt: SearchExcerpt | null
}

/** Which lifecycle timestamp (see RawNoteFile) the recent-notes list is ordered by. */
export type RecentNotesSort = 'created' | 'updated' | 'opened'

export interface RecentNote {
  filename: string
  preview: string
  /** ISO-8601 value of the timestamp the list was sorted by. */
  timestamp: string
}

/** Narrows search results by whether a note has any relationship, incoming or outgoing. */
export type OrphanFilter = 'any' | 'orphan' | 'connected'

export interface SearchCriteria {
  query: string
  orphan: OrphanFilter
}

/** Results per page for every paginated note list (search, recent). */
export const NOTE_LIST_PAGE_SIZE = 40

/** Progress ticks emitted while rebuildIndex works through the note directory, so the UI can show a determinate count instead of an indefinite spinner. */
export interface IndexProgress {
  loaded: number
  total: number
}

export interface NotesBootstrap {
  /** Empty string until the user has chosen a folder (status 'no-folder'). */
  graphPath: string
  status: 'ready' | 'no-folder' | 'missing-directory' | 'empty' | 'error'
  message?: string
  pins?: PinSpec[]
}

export interface NotesSearchRequest extends SearchCriteria {
  /** Zero-based page of NOTE_LIST_PAGE_SIZE results. */
  page: number
}

export interface NotesSearchResponse {
  graphPath: string
  /** The requested page, in the same order across every page. */
  results: SearchResult[]
  /** Every match, across all pages. */
  total: number
}

export interface SearchFilenamesResponse {
  /** Best matches first, truncated to the requested cap. */
  filenames: string[]
  /** Every match, including those cut by the cap. */
  total: number
}

export interface RecentNotesRequest {
  sort: RecentNotesSort
  /** Zero-based page of NOTE_LIST_PAGE_SIZE results. */
  page: number
}

export interface RecentNotesResponse {
  /** The requested page, newest first. Notes never stamped with the requested timestamp are omitted. */
  results: RecentNote[]
  /** Every stamped note, across all pages. */
  total: number
}

export interface NotesGraphResponse {
  graphPath: string
  graph: NoteGraph
}

export interface CreateNoteRequest {
  /** Filename (with extension) of the existing note the new note is being connected to. Omit to create a freestanding, unconnected note. */
  relatedFilename?: string
  /** Relation label. Falls back to a sensible default when blank. Ignored when relatedFilename is omitted. */
  label?: string
  /** When false (default): relatedFilename -> newNote. When true: newNote -> relatedFilename. */
  reverse?: boolean
  body: string
}

export interface CreateNoteResponse {
  filename: string
  /** The relation label actually written to disk, present whenever relatedFilename was given. */
  label?: string
}

export interface DeleteNoteRequest {
  filename: string
}

export interface UpdateNoteRequest {
  filename: string
  body: string
  /** Full desired extra content - empty string removes the `extra` key. Always sent (unlike a PATCH-style partial). */
  extraContent: string
}

export interface AttachImageRequest {
  /** The note the media is being attached to (its .json filename). */
  filename: string
  /** A data: URL, e.g. "data:image/webp;base64,..." or "data:video/mp4;base64,...". */
  dataUrl: string
}

export interface AttachImageResponse {
  /** Filename the media was written under inside the graph folder's images/ subdirectory. */
  image: string
}

export interface ClearImageRequest {
  /** The note whose attached media should be removed (its .json filename). */
  filename: string
}

export interface OrphanedMediaResponse {
  /** Recognized attachment files that are not the active attachment of any indexed note. */
  count: number
}

export interface DeleteOrphanedMediaResponse {
  deletedCount: number
}

export interface MediaFileRequest {
  /** Filename inside the graph folder's images/ subdirectory. */
  image: string
}

export interface CopyMediaRequest {
  /** Chromium-decoded image re-encoded as PNG for Electron's native clipboard API. */
  pngDataUrl: string
}

export interface ConnectNotesRequest {
  source: string
  target: string
  label: string
}

export interface ConnectNotesResponse {
  /** The relation label actually written to disk (falls back to a default when blank). */
  label: string
}

export interface UpdateRelationRequest {
  source: string
  target: string
  label: string
  nextLabel: string
}

export interface DeleteRelationRequest {
  source: string
  target: string
  label: string
}

export interface RandomOrphanRequest {
  /** Filenames to exclude from the pick, i.e. notes already open on the graph. */
  exclude: string[]
}

export interface RandomOrphanResponse {
  /** Null when no orphan note is available to pick. */
  filename: string | null
}

export interface RandomNoteRequest {
  /** Filenames to exclude from the pick, i.e. notes already open on the graph. */
  exclude: string[]
}

export interface RandomNoteResponse {
  /** Null when every note is already excluded (open on the graph). */
  filename: string | null
}

export interface DeleteNoteEntryRequest {
  filename: string
  /** Index into that note's `notes` array of the entry to remove. */
  index: number
}

export interface UndoDeleteResponse {
  /** False when there was nothing pending to undo (already restored, or superseded by a later delete). */
  restored: boolean
}

export interface NotesApi {
  getBootstrap: () => Promise<NotesBootstrap>
  search: (request: NotesSearchRequest) => Promise<NotesSearchResponse>
  searchFilenames: (criteria: SearchCriteria, cap: number) => Promise<SearchFilenamesResponse>
  recentNotes: (request: RecentNotesRequest) => Promise<RecentNotesResponse>
  openGraph: (pins: PinSpec[]) => Promise<NotesGraphResponse>
  pickDirectory: () => Promise<NotesBootstrap>
  createNote: (request: CreateNoteRequest) => Promise<CreateNoteResponse>
  deleteNote: (request: DeleteNoteRequest) => Promise<void>
  updateNote: (request: UpdateNoteRequest) => Promise<void>
  attachImage: (request: AttachImageRequest) => Promise<AttachImageResponse>
  clearImage: (request: ClearImageRequest) => Promise<void>
  findOrphanedMedia: () => Promise<OrphanedMediaResponse>
  deleteOrphanedMedia: () => Promise<DeleteOrphanedMediaResponse>
  getMediaDataUrl: (request: MediaFileRequest) => Promise<string>
  copyMedia: (request: CopyMediaRequest) => Promise<void>
  copyMediaPath: (request: MediaFileRequest) => Promise<void>
  connectNotes: (request: ConnectNotesRequest) => Promise<ConnectNotesResponse>
  updateRelationLabel: (request: UpdateRelationRequest) => Promise<void>
  deleteRelation: (request: DeleteRelationRequest) => Promise<void>
  randomOrphan: (request: RandomOrphanRequest) => Promise<RandomOrphanResponse>
  randomNote: (request: RandomNoteRequest) => Promise<RandomNoteResponse>
  deleteNoteEntry: (request: DeleteNoteEntryRequest) => Promise<void>
  /** Restores whatever `deleteNote`/`deleteRelation` most recently removed. */
  undoDelete: () => Promise<UndoDeleteResponse>
  /**
   * Fires whenever the backend's note index is rebuilt - after any mutation
   * (create/update/delete/connect/relation change/undo) as well as manual
   * re-index and folder switches. This is the single signal every note-derived
   * view (graph, search, ...) should key its own refresh off of, rather than
   * each mutation call site remembering to poke every consumer individually.
   * Returns an unsubscribe function.
   */
  onChanged: (callback: () => void) => () => void
  /** Fires repeatedly while a note index rebuild is in progress. Returns an unsubscribe function. */
  onIndexProgress: (callback: (progress: IndexProgress) => void) => () => void
}
