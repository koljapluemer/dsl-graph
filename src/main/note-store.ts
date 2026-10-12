import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { Document } from 'flexsearch'
import { RE2 } from 're2-wasm'
import { GraphWatcher, type GraphChangeBatch } from './graph-watcher'
import {
  IMAGES_DIR_NAME,
  isNoteFilename,
  SUPPORTED_IMAGE_EXTENSIONS,
  SUPPORTED_MEDIA_EXTENSIONS,
  SUPPORTED_VIDEO_EXTENSIONS
} from './graph-fs'
import { MAX_VIDEO_ATTACHMENT_BYTES } from '../shared/media'
import { errorsOf, parseDocument, type Document as ItemDocument } from './dsl/document'
import { ITEM_SCHEMA } from './dsl/item-schema'
import { serializeDocument } from './dsl/serialize'
import {
  UNLABELED_RELATION,
  addRelation,
  newNoteDocument,
  noteFilename,
  noteStem,
  readNoteContent,
  relabelRelation,
  removeRelation,
  setBody,
  setExtra,
  setMedia
} from './note-file'
import { selectRecentNotes } from './recent-notes'
import { buildMatchDisplay, locateFuzzyMatch, type LocatedMatch } from './search-match-display'
import {
  IncompleteSearchQueryError,
  parseSearchQuery,
  type SearchField,
  type SearchQueryNode
} from './search-query'
import { matchesOrphanFilter, orderByHeadScore } from './search-ordering'
import type {
  AttachImageRequest,
  AttachImageResponse,
  ClearImageRequest,
  ConnectNotesRequest,
  ConnectNotesResponse,
  CreateNoteRequest,
  CreateNoteResponse,
  DeleteNoteRequest,
  DeleteRelationRequest,
  GraphEdgePayload,
  GraphNodePayload,
  IndexedNote,
  IndexProgress,
  NoteGraph,
  NoteLink,
  NotesBootstrap,
  NotesGraphResponse,
  NotesSearchRequest,
  NotesSearchResponse,
  PinSpec,
  RandomNoteRequest,
  RandomNoteResponse,
  RandomOrphanRequest,
  RandomOrphanResponse,
  RecentNotesRequest,
  RecentNotesResponse,
  SearchCriteria,
  SearchFilenamesResponse,
  SearchResult,
  UndoDeleteResponse,
  UpdateNoteRequest,
  UpdateRelationRequest
} from '../shared/notes'
import { NOTE_LIST_PAGE_SIZE } from '../shared/notes'
import type {
  RawSearchCorpusEntry,
  RawSearchMatch,
  RawSearchWorkerRequest,
  RawSearchWorkerResponse
} from './search-worker-types'

const SETTINGS_FILE_NAME = 'graphirst-settings.json'
/**
 * Subtracted from the score of a result that matched only in a note's extra
 * content (nothing in the body). Large enough to sink every such result below
 * every body match, so they land at the tail of the same list without being
 * split out or labelled.
 */
const EXTRA_ONLY_RANK_PENALTY = 100_000
const MAX_DIRECT_RELATIONS = 28
const MAX_SECONDARY_RELATIONS = 12
const MAX_GRAPH_NODES = 140
/** Defense in depth only - RE2 is linear-time, so this should never actually fire. */
const RAW_SEARCH_TIMEOUT_MS = 5000
/**
 * Above this many changed note files in a single batch, one clean full reindex is
 * cheaper and safer than that many incremental FlexSearch updates (each of which,
 * with the context index, costs O(field-index size) - see createSearchIndex).
 */
const INCREMENTAL_BATCH_LIMIT = 50

interface StoredSettings {
  graphPath?: string
  pins?: PinSpec[]
}

interface FuzzyCandidate {
  id: number | string
}

/** A fuzzy query folded once per search, the way every note field is folded before comparing. */
interface FuzzyQuery {
  normalized: string
  tokens: string[]
}

interface FuzzyMatchedFields {
  /** Folded body and extra content. */
  body: string
  extra: string
  /** Matched in the extra content and nowhere in the body. */
  extraOnly: boolean
}

/** One matching note, in result order; `rawMatch` is set for raw/regex searches and carries where it matched. */
interface SearchHit {
  filename: string
  note: IndexedNote
  rawMatch: RawSearchMatch | null
  fuzzyQuery: FuzzyQuery | null
  engineRank: number
}

/** `('image', 'jpeg')` -> `'jpg'`, `('video', 'quicktime')` -> `'mov'`; otherwise the subtype as-is. */
function normalizeMediaExtension(kind: 'image' | 'video', subtype: string): string {
  const lower = subtype.toLowerCase()
  if (kind === 'image') {
    return lower === 'jpeg' ? 'jpg' : lower
  }
  return lower === 'quicktime' ? 'mov' : lower
}

/** Whether this app wrote the media file and may delete it: directly inside `images/`. */
function isManagedMedia(path: string): boolean {
  const [dir, name, ...rest] = path.split('/')
  return dir === IMAGES_DIR_NAME && name !== undefined && rest.length === 0
}

interface SearchDocument extends Record<string, string> {
  id: string
  body: string
  extra: string
}

interface IncomingRelation {
  source: string
  label: string
}

interface NodeMeta {
  depth: number
  order: number
}

interface QueueItem {
  filename: string
  depth: number
  /** The depth budget of the pin that discovered this item - not a global constant. */
  maxDepth: number
}

interface RelationDraft {
  source: string
  target: string
  label: string
  direction: 'incoming' | 'outgoing'
}

interface PendingNoteImage {
  /** The note's media path (relative to the graph folder) to restore the bytes under on undo. */
  path: string
  data: Buffer
}

/** The single most recent deletion, kept just long enough for the UI's undo popup to act on it. */
type PendingUndo =
  | { type: 'note'; filename: string; raw: string; image: PendingNoteImage | null }
  | { type: 'relation'; source: string; relation: NoteLink }

interface GraphBuildContext {
  nodes: Map<string, NodeMeta>
  edges: Map<string, GraphEdgePayload>
  queue: QueueItem[]
  skippedRelations: number
  skippedNodes: number
}

/** One unit of incremental index work: note files to (re)read and note files gone. */
interface IndexChangeSet {
  upsert: string[]
  remove: string[]
}

/** Search-worker corpus delta accumulated across one applyFileChanges pass. */
interface WorkerDelta {
  upserts: RawSearchCorpusEntry[]
  removals: string[]
}

/** Emitted whenever the note index is rebuilt - the single "notes changed" signal (see NotesApi.onChanged). */
export const NOTES_CHANGED_EVENT = 'changed'
/** Emitted repeatedly while rebuildIndex works through the note directory (see NotesApi.onIndexProgress). */
export const NOTES_INDEX_PROGRESS_EVENT = 'index-progress'

export class NoteStore extends EventEmitter {
  /** TTL for a store-originated write's path in pendingSelfWrites, so the watcher can tell its own echo from a real external edit. */
  private static readonly SELF_WRITE_TTL_MS = 2000

  private readonly settingsPath: string
  /** Empty until the user picks a folder (status 'no-folder'); there is no built-in default. */
  private graphPath = ''
  private lastPins: PinSpec[] = []
  private notes = new Map<string, IndexedNote>()
  /** Media path -> how many indexed notes reference it, kept in step with `notes`. */
  private mediaRefs = new Map<string, number>()
  private reverseRefs = new Map<string, IncomingRelation[]>()
  private searchIndex = this.createSearchIndex()
  private status: NotesBootstrap['status'] = 'no-folder'
  private message?: string
  private hasIndexed = false
  private inFlightIndex: Promise<void> | null = null
  private pendingUndo: PendingUndo | null = null
  /** Resident copy mirrored into the raw-search worker - reassigned only by a full index, patched in place by incremental applies. */
  private rawSearchCorpus: RawSearchCorpusEntry[] = []
  /** filename -> its index in rawSearchCorpus, kept in step for O(1) incremental upsert/remove. */
  private rawCorpusIndex = new Map<string, number>()
  private searchWorker: Worker
  private nextRawRequestId = 1
  private pendingRawRequests = new Map<
    number,
    {
      resolve: (matches: RawSearchMatch[]) => void
      reject: (error: Error) => void
      timeout: NodeJS.Timeout
    }
  >()

  /** Serializes full reindexes and incremental applies so they never interleave. */
  private opChain: Promise<unknown> = Promise.resolve()

  /** absPath -> expiry epoch ms for writes this store just made, so its own writes don't round-trip through the watcher. */
  private pendingSelfWrites = new Map<string, number>()

  /**
   * missing-target filename -> source notes that hold a (currently dangling) rel
   * pointing at it. Lets an incremental apply re-read those senders when the
   * target reappears, restoring a rel a full index would have kept.
   */
  private danglingRefSources = new Map<string, Set<string>>()

  private readonly watcher: GraphWatcher

  constructor(settingsDir: string) {
    super()
    this.settingsPath = join(settingsDir, SETTINGS_FILE_NAME)
    this.searchWorker = this.spawnSearchWorker()
    this.watcher = new GraphWatcher()
    this.watcher.on('batch', (batch) => void this.onWatcherBatch(batch))
    this.watcher.on('error', (error) => console.warn('Graph watcher error:', error))
  }

  /** Runs `task` after all previously enqueued index work has settled. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(task, task)
    this.opChain = run.catch(() => undefined)
    return run
  }

  getCurrentPath(): string {
    return this.graphPath
  }

  async getBootstrap(): Promise<NotesBootstrap> {
    await this.ensureIndexed()

    return {
      graphPath: this.graphPath,
      status: this.status,
      message: this.message,
      pins: this.lastPins
    }
  }

  async setGraphPath(graphPath: string): Promise<NotesBootstrap> {
    this.graphPath = graphPath
    this.hasIndexed = false
    this.pendingUndo = null
    await this.persistSettings()
    await this.ensureIndexed(true)
    return this.getBootstrap()
  }

  async search(request: NotesSearchRequest): Promise<NotesSearchResponse> {
    await this.ensureIndexed()
    this.assertIndexReady()

    const hits = await this.orderedHits(request)
    const start = request.page * NOTE_LIST_PAGE_SIZE
    return {
      graphPath: this.graphPath,
      results: hits
        .slice(start, start + NOTE_LIST_PAGE_SIZE)
        .map((hit) => this.toSearchResult(hit)),
      total: hits.length
    }
  }

  /** Filenames of the first `cap` matches, in the same order `search` pages through, plus the full match count. */
  async searchFilenames(criteria: SearchCriteria, cap: number): Promise<SearchFilenamesResponse> {
    await this.ensureIndexed()
    this.assertIndexReady()

    const hits = await this.orderedHits(criteria)
    return { filenames: hits.slice(0, cap).map((hit) => hit.filename), total: hits.length }
  }

  /**
   * Every note matching `criteria`, in final result order (see orderByHeadScore).
   * Only filenames and notes are carried - match display is built later, for the
   * requested page alone, so a broad query never builds 100k excerpts.
   */
  private async orderedHits(criteria: SearchCriteria): Promise<SearchHit[]> {
    const trimmed = criteria.query.trim()
    if (!trimmed) {
      return []
    }

    let query: SearchQueryNode
    try {
      query = parseSearchQuery(trimmed)
    } catch (error) {
      if (error instanceof IncompleteSearchQueryError) return []
      throw error
    }

    const engineOrder = await this.queryHits(query)
    const kept = engineOrder.filter((hit) => matchesOrphanFilter(hit.note, criteria.orphan))
    return orderByHeadScore(kept, (hit) =>
      hit.rawMatch
        ? this.scoreRawHit(hit.note, hit.engineRank, hit.rawMatch)
        : hit.fuzzyQuery
          ? this.scoreFuzzyHit(hit.note, hit.engineRank, hit.fuzzyQuery)
          : 1000 - hit.engineRank * 5 + Math.min(hit.note.degree, 24)
    )
  }

  /** Evaluates the parsed query with set operations while retaining each hit's best display match. */
  private async queryHits(query: SearchQueryNode): Promise<SearchHit[]> {
    const matches = await this.evaluateQuery(query, 'content')
    return [...matches.values()]
  }

  private async evaluateQuery(
    query: SearchQueryNode,
    field: SearchField
  ): Promise<Map<string, SearchHit>> {
    if (query.type === 'scope') return this.evaluateQuery(query.child, query.field)
    if (query.type === 'term') return this.termHits(query, field)
    if (query.type === 'not') {
      const excluded = await this.evaluateQuery(query.child, field)
      const result = new Map<string, SearchHit>()
      let rank = 0
      for (const note of this.notes.values()) {
        if (!excluded.has(note.filename)) {
          result.set(note.filename, {
            filename: note.filename,
            note,
            rawMatch: null,
            fuzzyQuery: null,
            engineRank: rank++
          })
        }
      }
      return result
    }

    const parts = await Promise.all(query.children.map((child) => this.evaluateQuery(child, field)))
    if (query.type === 'or') {
      const result = new Map<string, SearchHit>()
      for (const part of parts) {
        for (const [filename, hit] of part) {
          const current = result.get(filename)
          if (!current || hit.engineRank < current.engineRank || !this.hasDisplayMatch(current)) {
            result.set(filename, hit)
          }
        }
      }
      return result
    }

    const [first, ...rest] = parts
    const result = new Map(first)
    for (const part of rest) {
      for (const [filename, current] of result) {
        const other = part.get(filename)
        if (!other) result.delete(filename)
        else if (!this.hasDisplayMatch(current) && this.hasDisplayMatch(other))
          result.set(filename, other)
      }
    }
    return result
  }

  private hasDisplayMatch(hit: SearchHit): boolean {
    return hit.rawMatch !== null || hit.fuzzyQuery !== null
  }

  private async termHits(
    term: Extract<SearchQueryNode, { type: 'term' }>,
    field: SearchField
  ): Promise<Map<string, SearchHit>> {
    if (field === 'file') return this.filenameHits(term)
    if (term.match !== 'fuzzy') {
      const fields: ('body' | 'extra')[] = field === 'content' ? ['body', 'extra'] : [field]
      const matches = await this.runRawSearch(
        term.value,
        term.match === 'regex',
        term.flags,
        fields,
        Math.max(this.rawSearchCorpus.length, 1)
      )
      return new Map(
        this.toSearchHits(
          matches.map((match) => [match.filename, match]),
          null
        ).map((hit) => [hit.filename, hit])
      )
    }

    const fuzzyQuery = this.prepareFuzzyQuery(term.value)
    const candidates: FuzzyCandidate[] = this.searchIndex.search(term.value, {
      enrich: true,
      limit: Math.max(this.notes.size, 1),
      merge: true,
      index: field === 'content' ? ['body', 'extra'] : field
    })
    const hits = this.toSearchHits(
      candidates.map((entry) => [String(entry.id), null]),
      fuzzyQuery
    )
    return new Map(hits.map((hit) => [hit.filename, hit]))
  }

  private filenameHits(term: Extract<SearchQueryNode, { type: 'term' }>): Map<string, SearchHit> {
    const result = new Map<string, SearchHit>()
    const regex =
      term.match === 'regex'
        ? new RE2(term.value, term.flags.includes('u') ? term.flags : `${term.flags}u`)
        : null
    const needle = this.normalize(term.value)
    let rank = 0
    for (const note of this.notes.values()) {
      const matches = regex
        ? regex.test(note.filename)
        : this.normalize(note.filename).includes(needle)
      if (matches) {
        result.set(note.filename, {
          filename: note.filename,
          note,
          rawMatch: null,
          fuzzyQuery: null,
          engineRank: rank++
        })
      }
    }
    return result
  }

  /** Resolves engine results against the live index, dropping any the index no longer holds. */
  private toSearchHits(
    entries: [filename: string, rawMatch: RawSearchMatch | null][],
    fuzzyQuery: FuzzyQuery | null
  ): SearchHit[] {
    const hits: SearchHit[] = []
    for (const [engineRank, [filename, rawMatch]] of entries.entries()) {
      const note = this.notes.get(filename)
      if (note) {
        hits.push({ filename, note, rawMatch, fuzzyQuery, engineRank })
      }
    }
    return hits
  }

  private toSearchResult(hit: SearchHit): SearchResult {
    const located = hit.rawMatch
      ? this.locateRawMatch(hit.rawMatch)
      : hit.fuzzyQuery
        ? this.locateFuzzyMatch(hit.note, hit.fuzzyQuery)
        : null
    return { filename: hit.filename, ...buildMatchDisplay(hit.note, located) }
  }

  private runRawSearch(
    pattern: string,
    isRegex: boolean,
    flags: string,
    fields: ('body' | 'extra')[],
    limit: number
  ): Promise<RawSearchMatch[]> {
    return new Promise((resolve, reject) => {
      const requestId = this.nextRawRequestId++
      const timeout = setTimeout(() => {
        this.pendingRawRequests.delete(requestId)
        reject(new Error('Raw search timed out.'))
      }, RAW_SEARCH_TIMEOUT_MS)

      this.pendingRawRequests.set(requestId, { resolve, reject, timeout })

      const request: RawSearchWorkerRequest = {
        type: 'search',
        requestId,
        pattern,
        isRegex,
        flags,
        fields,
        limit
      }
      this.searchWorker.postMessage(request)
    })
  }

  private spawnSearchWorker(): Worker {
    const worker = new Worker(join(__dirname, 'search-worker.js'))
    // Never let the worker's own liveness hold the Electron main process open.
    worker.unref()
    worker.on('message', (message: RawSearchWorkerResponse) => this.handleWorkerMessage(message))
    worker.on('error', (error: Error) => this.handleWorkerFailure(error))
    worker.on('exit', (code) => {
      if (code !== 0) {
        this.handleWorkerFailure(new Error(`Search worker exited with code ${code}`))
      }
    })

    const sync: RawSearchWorkerRequest = { type: 'sync', corpus: this.rawSearchCorpus }
    worker.postMessage(sync)
    return worker
  }

  private syncSearchWorker(): void {
    const sync: RawSearchWorkerRequest = { type: 'sync', corpus: this.rawSearchCorpus }
    this.searchWorker.postMessage(sync)
  }

  private handleWorkerMessage(message: RawSearchWorkerResponse): void {
    const pending = this.pendingRawRequests.get(message.requestId)
    if (!pending) {
      return
    }

    this.pendingRawRequests.delete(message.requestId)
    clearTimeout(pending.timeout)

    if (message.type === 'error') {
      pending.reject(new Error(message.message))
    } else {
      pending.resolve(message.matches)
    }
  }

  /** A crashed/hung worker fails every request in flight, then gets replaced and resynced so the next raw search isn't left permanently broken. */
  private handleWorkerFailure(error: Error): void {
    for (const pending of this.pendingRawRequests.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pendingRawRequests.clear()
    this.searchWorker = this.spawnSearchWorker()
  }

  async openGraph(pins: PinSpec[]): Promise<NotesGraphResponse> {
    await this.ensureIndexed()
    this.assertIndexReady()

    this.lastPins = pins
    await this.persistSettings()

    return {
      graphPath: this.graphPath,
      graph: this.buildGraph(pins)
    }
  }

  async createNote(request: CreateNoteRequest): Promise<CreateNoteResponse> {
    await this.ensureIndexed()

    if (request.relatedFilename && !this.notes.has(request.relatedFilename)) {
      throw new Error(`Could not find "${request.relatedFilename}" in ${this.graphPath}.`)
    }

    const filename = this.generateFilename(request.body)
    const doc = newNoteDocument(request.body)

    if (!request.relatedFilename) {
      await this.writeNote(filename, doc)
      await this.applyLocalChange({ upsert: [filename] })
      return { filename }
    }

    const label = (request.label ?? '').trim() || UNLABELED_RELATION

    if (request.reverse) {
      addRelation(doc, { label, target: request.relatedFilename })
      await this.writeNote(filename, doc)
    } else {
      await this.writeNote(filename, doc)
      await this.mutateNote(request.relatedFilename, (related) =>
        addRelation(related, { label, target: filename })
      )
    }

    await this.applyLocalChange({ upsert: [filename, request.relatedFilename] })

    return { filename, label }
  }

  async deleteNote(request: DeleteNoteRequest): Promise<void> {
    await this.ensureIndexed()

    const existing = this.notes.get(request.filename)
    if (!existing) {
      throw new Error(`Could not find "${request.filename}" in ${this.graphPath}.`)
    }

    const path = join(this.graphPath, request.filename)
    const raw = await readFile(path, 'utf8')

    // Kept in memory (not just deleted-and-forgotten) for the same reason the note's
    // own text is: `undoDelete` needs to be able to fully restore the note, media
    // included, without a permanently-broken media reference.
    let image: PendingNoteImage | null = null
    if (existing.image) {
      image = await this.readMediaForUndo(existing.image)
      await this.releaseMedia(request.filename, existing.image)
    }

    this.markSelfWrite(path)
    await unlink(path)
    this.pendingUndo = { type: 'note', filename: request.filename, raw, image }
    await this.applyLocalChange({ remove: [request.filename] })
  }

  async findOrphanedMedia(): Promise<{ count: number }> {
    await this.ensureIndexed()
    return { count: (await this.orphanedMediaFiles()).length }
  }

  async deleteOrphanedMedia(): Promise<{ deletedCount: number }> {
    await this.ensureIndexed()

    const orphanedFiles = await this.orphanedMediaFiles()
    await Promise.all(orphanedFiles.map((path) => this.unlinkIfPresent(join(this.graphPath, path))))

    return { deletedCount: orphanedFiles.length }
  }

  async updateNote(request: UpdateNoteRequest): Promise<void> {
    await this.ensureIndexed()

    if (!this.notes.has(request.filename)) {
      throw new Error(`Could not find "${request.filename}" in ${this.graphPath}.`)
    }

    await this.mutateNote(request.filename, (doc) => {
      setBody(doc, request.body)
      setExtra(doc, request.extraContent)
    })

    await this.applyLocalChange({ upsert: [request.filename] })
  }

  /**
   * Writes `dataUrl`'s bytes to `images/<noteStem>-<epochMillis>.<ext>` and points
   * the note's `media` line at it, replacing any image or video already attached.
   */
  async attachImage(request: AttachImageRequest): Promise<AttachImageResponse> {
    await this.ensureIndexed()

    const note = this.notes.get(request.filename)
    if (!note) {
      throw new Error(`Could not find "${request.filename}" in ${this.graphPath}.`)
    }

    const match = /^data:(image|video)\/(\w+);base64,(.+)$/.exec(request.dataUrl)
    if (!match) {
      throw new Error('Unsupported media data.')
    }

    const [, kindMatch, subtype, base64] = match
    const kind = kindMatch as 'image' | 'video'
    const extension = normalizeMediaExtension(kind, subtype)
    const allowedExtensions =
      kind === 'image' ? SUPPORTED_IMAGE_EXTENSIONS : SUPPORTED_VIDEO_EXTENSIONS
    if (!allowedExtensions.has(extension)) {
      throw new Error(`Unsupported ${kind} type: ${extension}.`)
    }

    if (kind === 'video') {
      // Exact for unpadded base64, off by at most 2 bytes with padding - fine for a size gate.
      const byteLength = Math.ceil((base64.length * 3) / 4)
      if (byteLength > MAX_VIDEO_ATTACHMENT_BYTES) {
        const maxMb = Math.round(MAX_VIDEO_ATTACHMENT_BYTES / (1024 * 1024))
        throw new Error(`Video is too large; keep clips under ${maxMb}MB.`)
      }
    }

    const image = `${IMAGES_DIR_NAME}/${noteStem(request.filename)}-${Date.now()}.${extension}`
    await mkdir(this.imagesDir(), { recursive: true })
    await writeFile(join(this.graphPath, image), Buffer.from(base64, 'base64'))
    await this.mutateNote(request.filename, (doc) => setMedia(doc, image))
    if (note.image) {
      await this.releaseMedia(request.filename, note.image)
    }

    await this.applyLocalChange({ upsert: [request.filename] })
    return { image }
  }

  /** Removes the note's `media` line and the file it pointed at; no-op if none. */
  async clearImage(request: ClearImageRequest): Promise<void> {
    await this.ensureIndexed()

    const note = this.notes.get(request.filename)
    if (!note) {
      throw new Error(`Could not find "${request.filename}" in ${this.graphPath}.`)
    }
    if (!note.image) {
      return
    }

    await this.mutateNote(request.filename, (doc) => setMedia(doc, null))
    await this.releaseMedia(request.filename, note.image)
    await this.applyLocalChange({ upsert: [request.filename] })
  }

  async connectNotes(request: ConnectNotesRequest): Promise<ConnectNotesResponse> {
    await this.ensureIndexed()

    if (!this.notes.has(request.source)) {
      throw new Error(`Could not find "${request.source}" in ${this.graphPath}.`)
    }
    if (!this.notes.has(request.target)) {
      throw new Error(`Could not find "${request.target}" in ${this.graphPath}.`)
    }

    const label = request.label.trim() || UNLABELED_RELATION
    await this.mutateNote(request.source, (doc) =>
      addRelation(doc, { label, target: request.target })
    )

    await this.applyLocalChange({ upsert: [request.source, request.target] })

    return { label }
  }

  async updateRelationLabel(request: UpdateRelationRequest): Promise<void> {
    await this.ensureIndexed()
    await this.mutateNote(request.source, (doc) =>
      relabelRelation(
        doc,
        { label: request.label, target: request.target },
        request.nextLabel.trim() || request.label
      )
    )

    await this.applyLocalChange({ upsert: [request.source, request.target] })
  }

  async deleteRelation(request: DeleteRelationRequest): Promise<void> {
    const relation: NoteLink = { label: request.label, target: request.target }
    await this.mutateNote(request.source, (doc) => removeRelation(doc, relation))

    this.pendingUndo = { type: 'relation', source: request.source, relation }
    await this.applyLocalChange({ upsert: [request.source, request.target] })
  }

  async undoDelete(): Promise<UndoDeleteResponse> {
    const pending = this.pendingUndo
    if (!pending) {
      return { restored: false }
    }

    this.pendingUndo = null

    if (pending.type === 'note') {
      const notePath = join(this.graphPath, pending.filename)
      this.markSelfWrite(notePath)
      await writeFile(notePath, pending.raw, 'utf8')
      if (pending.image) {
        const imagePath = join(this.graphPath, pending.image.path)
        await mkdir(dirname(imagePath), { recursive: true })
        await writeFile(imagePath, pending.image.data)
      }
      await this.applyLocalChange({ upsert: [pending.filename] })
    } else {
      await this.mutateNote(pending.source, (doc) => addRelation(doc, pending.relation))
      await this.applyLocalChange({ upsert: [pending.source, pending.relation.target] })
    }

    return { restored: true }
  }

  async randomOrphan(request: RandomOrphanRequest): Promise<RandomOrphanResponse> {
    await this.ensureIndexed()
    this.assertIndexReady()

    return { filename: this.pickRandomFilename(request.exclude, (note) => note.degree === 0) }
  }

  async recentNotes(request: RecentNotesRequest): Promise<RecentNotesResponse> {
    await this.ensureIndexed()
    this.assertIndexReady()

    return selectRecentNotes(this.notes.values(), request.page)
  }

  async randomNote(request: RandomNoteRequest): Promise<RandomNoteResponse> {
    await this.ensureIndexed()
    this.assertIndexReady()

    return { filename: this.pickRandomFilename(request.exclude) }
  }

  private assertIndexReady(): void {
    if (this.status !== 'ready' && this.status !== 'empty') {
      throw new Error(this.message ?? 'The note index is not ready yet.')
    }
  }

  private pickRandomFilename(
    exclude: string[],
    predicate?: (note: IndexedNote) => boolean
  ): string | null {
    const excluded = new Set(exclude)
    const candidates: string[] = []
    for (const note of this.notes.values()) {
      if (!excluded.has(note.filename) && (!predicate || predicate(note))) {
        candidates.push(note.filename)
      }
    }

    if (candidates.length === 0) {
      return null
    }

    return candidates[Math.floor(Math.random() * candidates.length)]
  }

  async loadSettings(): Promise<void> {
    try {
      const raw = await readFile(this.settingsPath, 'utf8')
      const parsed = JSON.parse(raw) as StoredSettings

      if (typeof parsed.graphPath === 'string' && parsed.graphPath.trim()) {
        this.graphPath = parsed.graphPath
      }

      if (Array.isArray(parsed.pins)) {
        this.lastPins = parsed.pins.filter(
          (pin): pin is PinSpec =>
            typeof pin === 'object' &&
            pin !== null &&
            typeof pin.filename === 'string' &&
            pin.filename.trim().length > 0 &&
            typeof pin.depth === 'number' &&
            pin.depth >= 0
        )
      }
    } catch (error) {
      const maybeError = error as NodeJS.ErrnoException
      if (maybeError.code !== 'ENOENT') {
        console.warn('Failed to load settings:', error)
      }
    }
  }

  private async ensureIndexed(force = false): Promise<void> {
    if (force) {
      this.hasIndexed = false
    }

    if (this.hasIndexed) {
      return
    }

    if (!this.inFlightIndex) {
      this.inFlightIndex = this.enqueue(() => this.rebuildIndex())
        .then(() => {
          this.emit(NOTES_CHANGED_EVENT)
        })
        .finally(() => {
          this.inFlightIndex = null
        })
    }

    await this.inFlightIndex
  }

  /** Wraps the full index so the watcher is always brought in line with the resulting status. */
  private async rebuildIndex(): Promise<void> {
    try {
      await this.runFullIndex()
    } finally {
      await this.syncWatcher()
    }
  }

  private async runFullIndex(): Promise<void> {
    this.resetIndex()

    if (!this.graphPath) {
      this.status = 'no-folder'
      this.message = undefined
      this.hasIndexed = true
      return
    }

    if (!existsSync(this.graphPath)) {
      this.status = 'missing-directory'
      this.message = `The graph folder does not exist: ${this.graphPath}`
      this.hasIndexed = true
      return
    }

    let dirEntries: string[]
    try {
      const entries = await readdir(this.graphPath, { withFileTypes: true })
      dirEntries = entries
        .filter((entry) => entry.isFile() && isNoteFilename(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right))
    } catch (error) {
      this.status = 'error'
      this.message = `Failed to read ${this.graphPath}: ${(error as Error).message}`
      this.hasIndexed = true
      return
    }

    if (dirEntries.length === 0) {
      this.status = 'empty'
      this.message = `No note files (*.txt) were found in ${this.graphPath}.`
      this.hasIndexed = true
      return
    }

    const batchSize = 200
    const corpusEntries: RawSearchCorpusEntry[] = []

    this.emit(NOTES_INDEX_PROGRESS_EVENT, {
      loaded: 0,
      total: dirEntries.length
    } satisfies IndexProgress)

    for (let batchStart = 0; batchStart < dirEntries.length; batchStart += batchSize) {
      const batch = dirEntries.slice(batchStart, batchStart + batchSize)
      const parsedNotes = await Promise.all(batch.map((filename) => this.readNoteFile(filename)))

      for (const note of parsedNotes) {
        if (!note) {
          continue
        }

        this.notes.set(note.filename, note)
        this.trackMedia(null, note.image)

        const doc: SearchDocument = {
          id: note.filename,
          body: note.body,
          extra: note.extraContent
        }
        this.searchIndex.add(doc)

        // note.bodyCompact/extraCompact are what buildMatchDisplay slices, so the
        // match indices the worker returns line up with them.
        corpusEntries.push({
          filename: note.filename,
          body: note.bodyCompact,
          extra: note.extraCompact
        })
      }

      this.emit(NOTES_INDEX_PROGRESS_EVENT, {
        loaded: Math.min(batchStart + batchSize, dirEntries.length),
        total: dirEntries.length
      } satisfies IndexProgress)
    }

    this.rawSearchCorpus = corpusEntries
    this.rawCorpusIndex = new Map(corpusEntries.map((entry, index) => [entry.filename, index]))
    this.syncSearchWorker()

    this.repairDanglingRelations()

    for (const note of this.notes.values()) {
      for (const rel of note.rels) {
        const incoming = this.reverseRefs.get(rel.target) ?? []
        incoming.push({ source: note.filename, label: rel.label })
        this.reverseRefs.set(rel.target, incoming)
      }
    }

    for (const note of this.notes.values()) {
      const incomingCount = this.reverseRefs.get(note.filename)?.length ?? 0
      note.degree = note.rels.length + incomingCount
    }

    this.status = 'ready'
    this.message = undefined
    this.hasIndexed = true
  }

  // ---------------------------------------------------------------------------
  // Incremental index maintenance
  // ---------------------------------------------------------------------------

  /**
   * Applies a single mutation this process just made to disk, patching the index
   * in place rather than rebuilding it. `emit(NOTES_CHANGED_EVENT)` is what the
   * old `ensureIndexed(true)` did after every mutation.
   */
  private async applyLocalChange(change: Partial<IndexChangeSet>): Promise<void> {
    await this.enqueue(() =>
      this.applyFileChanges({
        upsert: change.upsert ?? [],
        remove: change.remove ?? []
      })
    )
  }

  /**
   * The single incremental-apply path, shared by in-app mutations, the watcher,
   * and the safety reconcile. Preserves the ordering `runFullIndex` relies on:
   * notes+corpus -> scoped repair -> reverseRefs -> degree.
   * Emits `NOTES_CHANGED_EVENT` exactly once.
   */
  private async applyFileChanges(change: IndexChangeSet): Promise<void> {
    // Anything but a settled, ready index: a clean full build is both simpler and
    // safer than patching a half-formed one (also covers the first note created
    // in a previously-empty folder).
    if (!this.hasIndexed || this.status !== 'ready') {
      await this.rebuildIndex()
      this.emit(NOTES_CHANGED_EVENT)
      return
    }

    const touched = change.upsert.length + change.remove.length
    if (touched === 0) {
      return
    }
    if (touched > INCREMENTAL_BATCH_LIMIT) {
      await this.rebuildIndex()
      this.emit(NOTES_CHANGED_EVENT)
      return
    }

    const delta: WorkerDelta = { upserts: [], removals: [] }
    const affected = new Set<string>()
    const relSources = new Set<string>()
    const removed = new Set<string>()
    // Notes that did not exist before this batch - their appearance can un-break
    // a rel that was previously dropped as dangling.
    const newlyAdded = new Set<string>()
    const prevRelTargets = new Map<string, string[]>()

    // Reads one note and folds it in, recording the blast radius. Idempotent
    // within a batch (a filename already handled is skipped).
    const processUpsert = async (filename: string): Promise<void> => {
      if (relSources.has(filename)) {
        return
      }
      const { prev, next } = await this.indexNote(filename, delta)
      if (!prev && next) {
        newlyAdded.add(filename)
      }
      relSources.add(filename)
      affected.add(filename)
      prevRelTargets.set(
        filename,
        (prev?.rels ?? []).map((rel) => rel.target)
      )
      for (const rel of prev?.rels ?? []) {
        affected.add(rel.target)
      }
      for (const rel of next?.rels ?? []) {
        affected.add(rel.target)
      }
      if (!next) {
        removed.add(filename)
      }
    }

    // 1a. Read every upserted note into place (rels not yet repaired - a batch can
    //     contain both ends of a new relation, in any order).
    for (const filename of change.upsert) {
      await processUpsert(filename)
    }

    for (const filename of change.remove) {
      const prev = this.unindexNote(filename, delta)
      relSources.add(filename)
      affected.add(filename)
      removed.add(filename)
      prevRelTargets.set(
        filename,
        (prev?.rels ?? []).map((rel) => rel.target)
      )
      for (const rel of prev?.rels ?? []) {
        affected.add(rel.target)
      }
      for (const incoming of this.reverseRefs.get(filename) ?? []) {
        affected.add(incoming.source)
        relSources.add(incoming.source)
        if (!prevRelTargets.has(incoming.source)) {
          const source = this.notes.get(incoming.source)
          prevRelTargets.set(
            incoming.source,
            (source?.rels ?? []).map((rel) => rel.target)
          )
        }
      }
    }

    // 1b. A note that just appeared may make a previously dangling rel valid
    //     again - re-read those senders from disk.
    const reviveSources = new Set<string>()
    for (const filename of newlyAdded) {
      for (const source of this.danglingRefSources.get(filename) ?? []) {
        reviveSources.add(source)
      }
      this.danglingRefSources.delete(filename)
    }
    for (const source of reviveSources) {
      await processUpsert(source)
    }

    // 2. Repair dangling rels: on every note just read (it may carry rels to
    //    missing targets) and on every note that pointed at something just removed.
    const repairCandidates = new Set<string>([...relSources])
    for (const trigger of removed) {
      for (const incoming of this.reverseRefs.get(trigger) ?? []) {
        repairCandidates.add(incoming.source)
      }
    }
    const repaired = this.repairRelsOf(repairCandidates)
    for (const [source, targetsBeforeRepair] of repaired) {
      relSources.add(source)
      affected.add(source)
      if (!prevRelTargets.has(source)) {
        prevRelTargets.set(source, targetsBeforeRepair)
      }
      for (const target of targetsBeforeRepair) {
        affected.add(target)
      }
    }

    // 3. reverseRefs: rebuild every changed source's contributions.
    for (const source of relSources) {
      const current = this.notes.get(source)?.rels ?? []
      this.repatchReverseRefs(source, prevRelTargets.get(source) ?? [], current)
    }
    for (const filename of change.remove) {
      if ((this.reverseRefs.get(filename)?.length ?? 0) === 0) {
        this.reverseRefs.delete(filename)
      }
    }

    // 4. degree.
    this.repatchDegrees(affected)

    // 5. hand the search worker just the delta.
    this.postWorkerDelta(delta.upserts, delta.removals)

    // 6. one signal per batch.
    this.emit(NOTES_CHANGED_EVENT)
  }

  /**
   * Reads one note file and folds it into `this.notes`, the FlexSearch index and
   * the raw-search corpus. A file that no longer reads is treated as a removal.
   */
  private async indexNote(
    filename: string,
    delta: WorkerDelta
  ): Promise<{ prev: IndexedNote | null; next: IndexedNote | null }> {
    const prev = this.notes.get(filename) ?? null
    const next = await this.readNoteFile(filename)

    if (!next) {
      if (prev) {
        this.unindexNote(filename, delta)
      }
      return { prev, next: null }
    }

    this.notes.set(filename, next)
    this.trackMedia(prev?.image ?? null, next.image)

    const doc: SearchDocument = { id: filename, body: next.body, extra: next.extraContent }
    if (prev) {
      this.searchIndex.update(filename, doc)
    } else {
      this.searchIndex.add(doc)
    }

    const entry: RawSearchCorpusEntry = {
      filename,
      body: next.bodyCompact,
      extra: next.extraCompact
    }
    this.upsertRawCorpus(entry)
    delta.upserts.push(entry)

    return { prev, next }
  }

  /** Removes one note from `this.notes`, the FlexSearch index and the raw-search corpus. */
  private unindexNote(filename: string, delta: WorkerDelta): IndexedNote | null {
    const prev = this.notes.get(filename) ?? null
    if (!prev) {
      return null
    }
    this.notes.delete(filename)
    this.trackMedia(prev.image, null)
    this.searchIndex.remove(filename)
    this.removeFromRawCorpus(filename)
    delta.removals.push(filename)
    return prev
  }

  /** Rewrites one source note's entries in `reverseRefs`: drop it from every prior target, re-add it to every current one. */
  private repatchReverseRefs(source: string, prevTargets: string[], currentRels: NoteLink[]): void {
    for (const target of new Set(prevTargets)) {
      const list = this.reverseRefs.get(target)
      if (!list) {
        continue
      }
      const kept = list.filter((entry) => entry.source !== source)
      if (kept.length > 0) {
        this.reverseRefs.set(target, kept)
      } else {
        this.reverseRefs.delete(target)
      }
    }

    for (const rel of currentRels) {
      const list = this.reverseRefs.get(rel.target) ?? []
      list.push({ source, label: rel.label })
      this.reverseRefs.set(rel.target, list)
    }
  }

  /** Recomputes `degree` for every note whose relation count or incoming-ref count moved. */
  private repatchDegrees(affected: Set<string>): void {
    for (const filename of affected) {
      const note = this.notes.get(filename)
      if (!note) {
        continue
      }

      const incoming = this.reverseRefs.get(filename)?.length ?? 0
      note.degree = note.rels.length + incoming
    }
  }

  private upsertRawCorpus(entry: RawSearchCorpusEntry): void {
    const at = this.rawCorpusIndex.get(entry.filename)
    if (at === undefined) {
      this.rawCorpusIndex.set(entry.filename, this.rawSearchCorpus.length)
      this.rawSearchCorpus.push(entry)
    } else {
      this.rawSearchCorpus[at] = entry
    }
  }

  /** Swap-removes from `rawSearchCorpus`; order is irrelevant (the worker linear-scans). */
  private removeFromRawCorpus(filename: string): void {
    const at = this.rawCorpusIndex.get(filename)
    if (at === undefined) {
      return
    }
    const last = this.rawSearchCorpus.length - 1
    if (at !== last) {
      const moved = this.rawSearchCorpus[last]
      this.rawSearchCorpus[at] = moved
      this.rawCorpusIndex.set(moved.filename, at)
    }
    this.rawSearchCorpus.pop()
    this.rawCorpusIndex.delete(filename)
  }

  private postWorkerDelta(upserts: RawSearchCorpusEntry[], removals: string[]): void {
    const removed = new Set(removals)
    const liveUpserts = upserts.filter((entry) => !removed.has(entry.filename))
    if (liveUpserts.length > 0) {
      this.searchWorker.postMessage({
        type: 'upsert',
        entries: liveUpserts
      } satisfies RawSearchWorkerRequest)
    }
    if (removals.length > 0) {
      this.searchWorker.postMessage({
        type: 'remove',
        filenames: removals
      } satisfies RawSearchWorkerRequest)
    }
  }

  // ---------------------------------------------------------------------------
  // Filesystem watcher glue
  // ---------------------------------------------------------------------------

  /**
   * Brings the watcher in line with the current status: it runs whenever a real,
   * readable folder is chosen - `ready` or `empty` - so that the first note added
   * to a brand-new folder is still picked up live.
   */
  private async syncWatcher(): Promise<void> {
    const folderIsLive = this.status === 'ready' || this.status === 'empty'
    try {
      if (folderIsLive && this.graphPath) {
        await this.watcher.start(this.graphPath)
      } else {
        await this.watcher.stop()
      }
    } catch (error) {
      console.warn('Failed to sync graph watcher:', error)
    }
  }

  /** Translates a watcher batch into an index change, dropping this store's own write echoes. */
  private async onWatcherBatch(batch: GraphChangeBatch): Promise<void> {
    if (!this.graphPath) {
      return
    }

    const notSelfWrite = (name: string): boolean =>
      !this.consumeSelfWrite(join(this.graphPath, name))

    const upsert = [...batch.added, ...batch.changed].filter(notSelfWrite)
    const remove = batch.removed.filter(notSelfWrite)

    if (upsert.length === 0 && remove.length === 0) {
      return
    }

    await this.enqueue(() => this.applyFileChanges({ upsert, remove }))
  }

  /**
   * Cheap add/remove drift check against the directory listing, to recover from
   * any filesystem event the OS dropped. Content edits are not covered here -
   * only a full app restart re-reads existing files from disk.
   */
  async reconcile(): Promise<void> {
    if (!this.hasIndexed || this.status !== 'ready' || !this.graphPath) {
      return
    }

    let names: string[]
    try {
      const entries = await readdir(this.graphPath, { withFileTypes: true })
      names = entries
        .filter((entry) => entry.isFile() && isNoteFilename(entry.name))
        .map((entry) => entry.name)
    } catch {
      return
    }

    const onDisk = new Set(names)
    const added = names.filter((name) => !this.notes.has(name))
    const removed = [...this.notes.keys()].filter((name) => !onDisk.has(name))
    if (added.length === 0 && removed.length === 0) {
      return
    }

    await this.enqueue(() => this.applyFileChanges({ upsert: added, remove: removed }))
  }

  /** Stops the watcher and tears down the search worker. Call on app shutdown. */
  async dispose(): Promise<void> {
    await this.watcher.stop()
    await this.searchWorker.terminate()
  }

  private markSelfWrite(absPath: string): void {
    this.pendingSelfWrites.set(absPath, Date.now() + NoteStore.SELF_WRITE_TTL_MS)
  }

  /** Returns true (and clears the record) if `absPath` was written by this store within the TTL. */
  private consumeSelfWrite(absPath: string): boolean {
    const now = Date.now()
    const expiry = this.pendingSelfWrites.get(absPath)
    if (expiry !== undefined) {
      this.pendingSelfWrites.delete(absPath)
    }
    for (const [key, value] of this.pendingSelfWrites) {
      if (value < now) {
        this.pendingSelfWrites.delete(key)
      }
    }
    return expiry !== undefined && expiry >= now
  }

  /** Reads and parses one note file; null (with a console warning) when it is unreadable or has syntax errors. */
  private async readNoteFile(filename: string): Promise<IndexedNote | null> {
    const path = join(this.graphPath, filename)
    try {
      const [raw, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
      const doc = parseDocument(ITEM_SCHEMA, raw)
      const errors = errorsOf(doc)
      if (errors.length > 0) {
        console.warn(`Skipping note ${filename} with syntax errors:`, errors)
        return null
      }

      const content = readNoteContent(doc)
      return {
        filename,
        body: content.body,
        bodyCompact: content.body.replace(/\s+/g, ' ').trim(),
        rels: content.rels,
        degree: content.rels.length,
        image: content.media,
        extraContent: content.extraContent,
        extraCompact: content.extraContent.replace(/\s+/g, ' ').trim(),
        mtimeMs: info.mtimeMs
      }
    } catch (error) {
      console.warn(`Skipping unreadable note ${filename}:`, error)
      return null
    }
  }

  /**
   * A relation can point at a target that isn't an indexed note - most often one
   * that was just deleted (still within its undo window), or one with syntax
   * errors. It must never surface as a graph node/edge (see
   * tckt/issues/do-not-show-broken-nodes.md), so it is dropped from this in-memory
   * pass only: writing the removal back to disk would make `undoDelete` unable to
   * fully restore the relationship if the delete is undone a moment later.
   */
  private repairDanglingRelations(): void {
    this.repairRelsOf(this.notes.keys())
  }

  /**
   * Drops rels to missing targets from each note in `candidates` (remembered in
   * `danglingRefSources` so they can be restored if the target reappears).
   * Returns each mutated note mapped to its rel targets *before* the repair.
   */
  private repairRelsOf(candidates: Iterable<string>): Map<string, string[]> {
    const mutated = new Map<string, string[]>()

    for (const filename of candidates) {
      const note = this.notes.get(filename)
      if (!note) {
        continue
      }

      const kept = note.rels.filter((rel) => {
        if (this.notes.has(rel.target)) {
          return true
        }
        this.recordDanglingSource(rel.target, filename)
        return false
      })

      if (kept.length === note.rels.length) {
        continue
      }

      mutated.set(
        filename,
        note.rels.map((rel) => rel.target)
      )
      note.rels = kept
    }

    return mutated
  }

  private recordDanglingSource(missingTarget: string, source: string): void {
    let sources = this.danglingRefSources.get(missingTarget)
    if (!sources) {
      sources = new Set()
      this.danglingRefSources.set(missingTarget, sources)
    }
    sources.add(source)
  }

  private createSearchIndex(): Document<SearchDocument> {
    return new Document<SearchDocument>({
      tokenize: 'forward',
      context: {
        depth: 2,
        resolution: 8,
        bidirectional: true
      },
      document: {
        id: 'id',
        index: [
          { field: 'body', tokenize: 'forward', resolution: 6, context: true },
          { field: 'extra', tokenize: 'forward', resolution: 6, context: true }
        ]
      }
    })
  }

  /** Counts weakly connected components; a degree-zero orphan is a one-node island. */
  private resetIndex(): void {
    this.notes.clear()
    this.mediaRefs.clear()
    this.reverseRefs.clear()
    this.searchIndex = this.createSearchIndex()
    this.status = 'empty'
    this.message = undefined
    this.danglingRefSources.clear()
    // Covers rebuildIndex's early-return paths (missing directory, read error,
    // empty folder) - the success path overwrites this with the real corpus
    // and syncs again once it's actually built.
    this.rawSearchCorpus = []
    this.rawCorpusIndex.clear()
    this.syncSearchWorker()
  }

  private prepareFuzzyQuery(trimmed: string): FuzzyQuery {
    const normalized = this.normalize(trimmed)
    return { normalized, tokens: this.tokenize(normalized) }
  }

  /** Which of a note's fields a fuzzy query lands in, on case- and diacritic-folded text. */
  private fuzzyMatchedFields(note: IndexedNote, query: FuzzyQuery): FuzzyMatchedFields {
    const body = this.normalize(note.body)
    const extra = this.normalize(note.extraContent)
    const occursIn = (haystack: string): boolean =>
      haystack.includes(query.normalized) || query.tokens.some((token) => haystack.includes(token))

    return {
      body,
      extra,
      extraOnly: !occursIn(body) && occursIn(extra)
    }
  }

  private scoreFuzzyHit(note: IndexedNote, engineRank: number, query: FuzzyQuery): number {
    const { body, extra, extraOnly } = this.fuzzyMatchedFields(note, query)

    let score = 1000 - engineRank * 5

    if (body.includes(query.normalized)) {
      score += 140
    }

    const matchingTokens = query.tokens.filter(
      (token) => body.includes(token) || extra.includes(token)
    )
    score += matchingTokens.length * 35

    if (query.tokens.length > 1 && matchingTokens.length === query.tokens.length) {
      score += 120
    }

    score += Math.min(note.degree, 24)

    // A hit that lives only in the extra content still belongs in the same result
    // list, just after every body hit.
    if (extraOnly) {
      score -= EXTRA_ONLY_RANK_PENALTY
    }

    return score
  }

  private scoreRawHit(note: IndexedNote, engineRank: number, match: RawSearchMatch): number {
    let score = 1000 - engineRank * 5

    if (match.bodyIndex !== null) {
      score += 140
    }

    score += Math.min(note.degree, 24)

    // Matched only in the extra content - keep it in the same list but after every body hit.
    if (match.bodyIndex === null && match.extraIndex !== null) {
      score -= EXTRA_ONLY_RANK_PENALTY
    }

    return score
  }

  /** Locates the match in the extra content when it isn't in the body, so the excerpt actually shows it. */
  private locateFuzzyMatch(note: IndexedNote, query: FuzzyQuery): LocatedMatch | null {
    const normalize = (value: string): string => this.normalize(value)
    const { extraOnly } = this.fuzzyMatchedFields(note, query)
    const field = extraOnly ? 'extra' : 'body'
    const compact = extraOnly ? note.extraCompact : note.bodyCompact
    const range = locateFuzzyMatch(compact, query.normalized, query.tokens, normalize)
    return range ? { field, range } : null
  }

  private locateRawMatch(match: RawSearchMatch): LocatedMatch | null {
    if (match.bodyIndex !== null) {
      return { field: 'body', range: { start: match.bodyIndex, length: match.bodyLength } }
    }
    if (match.extraIndex !== null) {
      return { field: 'extra', range: { start: match.extraIndex, length: match.extraLength } }
    }
    return null
  }

  /**
   * Multi-root BFS union: every pin is seeded (root + first-level expansion) before
   * the shared FIFO queue is drained, so the queue processes strictly in
   * non-decreasing hop-distance order across *all* pins simultaneously. That means
   * when MAX_GRAPH_NODES is hit, the nodes dropped are the globally-farthest ones
   * across the whole pin set, not just the tail of whichever pin was listed last.
   */
  private buildGraph(pins: PinSpec[]): NoteGraph {
    if (pins.length === 0) {
      return { nodes: [], edges: [], truncated: false, warnings: [] }
    }

    const context = this.createBuildContext()
    for (const pin of pins) {
      this.registerPinRoot(pin, context)
    }
    this.drainQueue(context)

    return this.finalizeGraph(context)
  }

  private createBuildContext(): GraphBuildContext {
    return { nodes: new Map(), edges: new Map(), queue: [], skippedRelations: 0, skippedNodes: 0 }
  }

  /**
   * A pin is always registered at depth 0, overwriting any prior (deeper) discovery
   * of the same filename by an earlier pin or by BFS - being a root always wins over
   * being a mere neighbor. Its relation expansion is unconditional, mirroring how the
   * old single-center code always fetched the center's direct relations regardless of
   * anything already queued.
   */
  private registerPinRoot(pin: PinSpec, context: GraphBuildContext): void {
    // A pin can outlive the note it points at (deleted from disk out-of-band, or a
    // stale pin persisted from a previous session) - there is nothing to render for
    // it, so skip the root entirely rather than fabricating a placeholder node.
    if (!this.notes.has(pin.filename)) {
      return
    }

    const existing = context.nodes.get(pin.filename)
    context.nodes.set(pin.filename, { depth: 0, order: existing?.order ?? context.nodes.size })

    if (pin.depth > 0) {
      this.expandRelationsAt(pin.filename, 0, pin.depth, context)
    }
  }

  /** Fetches and registers both relation directions for one note in one place. */
  private expandRelationsAt(
    filename: string,
    depth: number,
    maxDepth: number,
    context: GraphBuildContext
  ): void {
    this.registerRelations(
      filename,
      depth,
      maxDepth,
      this.buildOutgoingRelations(filename),
      context
    )
    this.registerRelations(
      filename,
      depth,
      maxDepth,
      this.buildIncomingRelations(filename),
      context
    )
  }

  private buildOutgoingRelations(filename: string): RelationDraft[] {
    return this.getOutgoing(filename)
      .filter((rel) => this.isRenderableNode(rel.target))
      .map((rel) => ({
        source: filename,
        target: rel.target,
        label: rel.label,
        direction: 'outgoing' as const
      }))
  }

  private buildIncomingRelations(filename: string): RelationDraft[] {
    return this.getIncoming(filename)
      .filter((rel) => this.isRenderableNode(rel.source))
      .map((rel) => ({
        source: rel.source,
        target: filename,
        label: rel.label,
        direction: 'incoming' as const
      }))
  }

  /**
   * Whether a note is fit to be discovered as the *other end* of a relation - i.e.
   * it is indexed. `repairDanglingRelations` already drops missing-target
   * relations, so this is a defensive backstop.
   */
  private isRenderableNode(filename: string): boolean {
    return this.notes.has(filename)
  }

  /** Caps and registers a relation batch, bounded by the discovering pin's own maxDepth. */
  private registerRelations(
    origin: string,
    depth: number,
    maxDepth: number,
    relations: RelationDraft[],
    context: GraphBuildContext
  ): void {
    const limit = depth === 0 ? MAX_DIRECT_RELATIONS : MAX_SECONDARY_RELATIONS
    const visible = relations.slice(0, limit)
    context.skippedRelations += Math.max(0, relations.length - visible.length)

    for (const relation of visible) {
      const edgeId = `${relation.source}__${relation.target}__${relation.label}`
      if (!context.edges.has(edgeId)) {
        context.edges.set(edgeId, { id: edgeId, ...relation, depth: depth + 1 })
      }

      const neighbor = relation.source === origin ? relation.target : relation.source
      if (depth + 1 > maxDepth) {
        continue
      }

      const isNew = this.registerNode(neighbor, depth + 1, context)
      if (isNew) {
        // Queue even a node sitting exactly at the depth budget: its own relations
        // still need to be examined so edges to other already-known nodes are found,
        // even though no *new* node will be discovered past it (the depth+1 > maxDepth
        // check above already prevents that on the next pass).
        context.queue.push({ filename: neighbor, depth: depth + 1, maxDepth })
      }
    }
  }

  private registerNode(filename: string, depth: number, context: GraphBuildContext): boolean {
    const existing = context.nodes.get(filename)
    if (!existing) {
      if (context.nodes.size >= MAX_GRAPH_NODES) {
        context.skippedNodes += 1
        return false
      }

      context.nodes.set(filename, { depth, order: context.nodes.size })
      return true
    }

    if (depth < existing.depth) {
      existing.depth = depth
    }
    return false
  }

  private drainQueue(context: GraphBuildContext): void {
    let current: QueueItem | undefined
    while ((current = context.queue.shift())) {
      this.expandRelationsAt(current.filename, current.depth, current.maxDepth, context)
    }
  }

  private finalizeGraph(context: GraphBuildContext): NoteGraph {
    const warnings: string[] = []
    if (context.skippedRelations > 0) {
      warnings.push(
        `Truncated ${context.skippedRelations} relationships to keep the graph responsive.`
      )
    }
    if (context.skippedNodes > 0) {
      warnings.push(
        `Skipped ${context.skippedNodes} additional notes after hitting the graph size cap.`
      )
    }

    return {
      nodes: Array.from(context.nodes.entries())
        .map(([filename, meta]) => this.buildGraphNode(filename, meta, context.nodes))
        .sort(
          (left, right) =>
            left.depth - right.depth ||
            right.degree - left.degree ||
            left.filename.localeCompare(right.filename)
        ),
      // An edge can be discovered pointing at a note that never made it into the node
      // set (e.g. it's past a pin's depth budget) - drop those here rather than
      // shipping a dangling reference: the renderer's ELK layout has no tolerance for
      // an edge whose endpoint isn't in its node list and throws on it.
      edges: Array.from(context.edges.values()).filter(
        (edge) => context.nodes.has(edge.source) && context.nodes.has(edge.target)
      ),
      truncated: warnings.length > 0,
      warnings
    }
  }

  private buildGraphNode(
    filename: string,
    meta: NodeMeta,
    shown: ReadonlyMap<string, NodeMeta>
  ): GraphNodePayload {
    // Every filename that reaches context.nodes is guaranteed to back a real note:
    // pin roots for missing notes are skipped in registerPinRoot, and neighbors are
    // only ever registered through buildOutgoingRelations/buildIncomingRelations,
    // which filter out missing targets via isRenderableNode before this runs.
    const note = this.notes.get(filename)!

    return {
      filename,
      body: note.body,
      image: note.image,
      extraContent: note.extraContent,
      depth: meta.depth,
      degree: note.degree,
      hiddenNeighbors: this.countHiddenNeighbors(note, shown)
    }
  }

  /**
   * Distinct notes related to `note` in either direction that pinning it would
   * render but the graph being built does not contain. Unlike `degree` this counts
   * neighbours, not relations (reciprocal / multi-label pairs and self-loops fold
   * away) and skips notes `isRenderableNode` would never show, so it matches
   * what expanding actually reveals. Walks the adjacency maps unsorted - the graph
   * is capped at MAX_GRAPH_NODES, so this stays cheap even around a huge hub.
   */
  private countHiddenNeighbors(note: IndexedNote, shown: ReadonlyMap<string, NodeMeta>): number {
    const neighbors = new Set<string>()
    for (const rel of note.rels) {
      neighbors.add(rel.target)
    }
    for (const ref of this.reverseRefs.get(note.filename) ?? []) {
      neighbors.add(ref.source)
    }

    let hidden = 0
    for (const neighbor of neighbors) {
      if (neighbor !== note.filename && !shown.has(neighbor) && this.isRenderableNode(neighbor)) {
        hidden += 1
      }
    }
    return hidden
  }

  private getOutgoing(filename: string): NoteLink[] {
    const note = this.notes.get(filename)
    return [...(note?.rels ?? [])].sort((left, right) => {
      const labelSort = left.label.localeCompare(right.label)
      return labelSort !== 0 ? labelSort : left.target.localeCompare(right.target)
    })
  }

  private getIncoming(filename: string): IncomingRelation[] {
    return [...(this.reverseRefs.get(filename) ?? [])].sort((left, right) => {
      const labelSort = left.label.localeCompare(right.label)
      return labelSort !== 0 ? labelSort : left.source.localeCompare(right.source)
    })
  }

  private normalize(value: string): string {
    return value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
  }

  private tokenize(value: string): string[] {
    return value.match(/[\p{L}\p{N}_-]+/gu) ?? []
  }

  private slugifyBody(body: string): string {
    const firstWords = body.trim().split(/\s+/).filter(Boolean).slice(0, 6).join(' ')
    const slug = firstWords
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '')
    return slug || 'note'
  }

  private generateFilename(body: string): string {
    const slug = this.slugifyBody(body)
    let candidate: string
    do {
      candidate = noteFilename(`${slug}-${randomBytes(3).toString('hex')}`)
    } while (this.notes.has(candidate) || existsSync(join(this.graphPath, candidate)))
    return candidate
  }

  private async writeNote(filename: string, doc: ItemDocument): Promise<void> {
    const path = join(this.graphPath, filename)
    this.markSelfWrite(path)
    await writeFile(path, serializeDocument(ITEM_SCHEMA, doc), 'utf8')
  }

  /**
   * Reads a note, applies `edit` to its parsed document and writes it back. Lines
   * this app doesn't own (other keywords, state lines, ...) are kept as they were;
   * an unchanged result isn't written, so the file's mtime stays meaningful.
   */
  private async mutateNote(filename: string, edit: (doc: ItemDocument) => void): Promise<void> {
    const path = join(this.graphPath, filename)
    const raw = await readFile(path, 'utf8')
    const doc = parseDocument(ITEM_SCHEMA, raw)
    if (errorsOf(doc).length > 0) {
      throw new Error(`"${filename}" has syntax errors - fix it in a text editor first.`)
    }

    edit(doc)
    const next = serializeDocument(ITEM_SCHEMA, doc)
    if (next === raw) {
      return
    }
    this.markSelfWrite(path)
    await writeFile(path, next, 'utf8')
  }

  private imagesDir(): string {
    return join(this.graphPath, IMAGES_DIR_NAME)
  }

  /**
   * Absolute path of a media path some indexed note references. Throws for any
   * other path, so the renderer can't use it to read arbitrary files.
   */
  mediaFilePath(path: string): string {
    if (!this.mediaRefs.has(path)) {
      throw new Error('Unknown media file.')
    }
    return join(this.graphPath, path)
  }

  /** Moves one note's contribution to `mediaRefs` from `prev` to `next`. */
  private trackMedia(prev: string | null, next: string | null): void {
    if (prev === next) {
      return
    }
    if (prev !== null) {
      const count = (this.mediaRefs.get(prev) ?? 1) - 1
      if (count > 0) {
        this.mediaRefs.set(prev, count)
      } else {
        this.mediaRefs.delete(prev)
      }
    }
    if (next !== null) {
      this.mediaRefs.set(next, (this.mediaRefs.get(next) ?? 0) + 1)
    }
  }

  /**
   * Deletes a media file `owner` no longer points at - but only one this app
   * manages (directly inside `images/`) and only when no other note still
   * references it. Called before the index catches up with `owner`'s edit, so
   * `owner`'s own reference is still counted.
   */
  private async releaseMedia(owner: string, path: string): Promise<void> {
    const ownReference = this.notes.get(owner)?.image === path ? 1 : 0
    if (isManagedMedia(path) && (this.mediaRefs.get(path) ?? 0) <= ownReference) {
      await this.unlinkIfPresent(join(this.graphPath, path))
    }
  }

  private async readMediaForUndo(path: string): Promise<PendingNoteImage | null> {
    try {
      return { path, data: await readFile(join(this.graphPath, path)) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw error
    }
  }

  private async unlinkIfPresent(path: string): Promise<void> {
    try {
      await unlink(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
  }

  /** Paths of the media files in `images/` that no indexed note references. */
  private async orphanedMediaFiles(): Promise<string[]> {
    let entries: string[]
    try {
      entries = await readdir(this.imagesDir())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw error
    }

    return entries
      .filter((entry) => {
        const dot = entry.lastIndexOf('.')
        return dot > 0 && SUPPORTED_MEDIA_EXTENSIONS.has(entry.slice(dot + 1).toLowerCase())
      })
      .map((entry) => `${IMAGES_DIR_NAME}/${entry}`)
      .filter((path) => !this.mediaRefs.has(path))
  }

  private async persistSettings(): Promise<void> {
    const directory = this.settingsPath.replace(/\/[^/]+$/, '')
    await mkdir(directory, { recursive: true })
    await writeFile(
      this.settingsPath,
      JSON.stringify(
        {
          graphPath: this.graphPath,
          pins: this.lastPins
        } satisfies StoredSettings,
        null,
        2
      ),
      'utf8'
    )
  }
}
