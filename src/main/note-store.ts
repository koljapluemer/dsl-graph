import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { Document } from 'flexsearch'
import { RE2 } from 're2-wasm'
import { GraphWatcher, type GraphChangeBatch } from './graph-watcher'
import {
  IMAGES_DIR_NAME,
  IMAGE_STEM_PATTERN,
  SUPPORTED_IMAGE_EXTENSIONS,
  SUPPORTED_MEDIA_EXTENSIONS,
  SUPPORTED_VIDEO_EXTENSIONS
} from './graph-fs'
import { MAX_VIDEO_ATTACHMENT_BYTES } from '../shared/media'
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
  DeleteNoteEntryRequest,
  DeleteNoteRequest,
  DeleteRelationRequest,
  GraphEdgePayload,
  GraphNodePayload,
  IndexedNote,
  IndexProgress,
  NoteGraph,
  NoteLink,
  NoteRelationTuple,
  NotesBootstrap,
  NotesGraphResponse,
  NotesSearchRequest,
  NotesSearchResponse,
  PinSpec,
  RandomNoteRequest,
  RandomNoteResponse,
  RandomOrphanRequest,
  RandomOrphanResponse,
  RawNoteFile,
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
  /** The exact `images/` filename to restore the bytes under on undo. */
  filename: string
  data: Buffer
}

/** The single most recent deletion, kept just long enough for the UI's undo popup to act on it. */
type PendingUndo =
  | {
      type: 'note'
      filename: string
      raw: string
      image: PendingNoteImage | null
      /** Notes that had `relationshipsChanged` stamped because they were wired to the deleted note - re-stamped on undo. */
      neighbors: string[]
    }
  | { type: 'relation'; source: string; relation: NoteRelationTuple }

/** Lifecycle timestamp keys this store stamps into note files (see RawNoteFile). */
type NoteTimestampField = 'created' | 'updated' | 'opened' | 'relationshipsChanged'

interface GraphBuildContext {
  nodes: Map<string, NodeMeta>
  edges: Map<string, GraphEdgePayload>
  queue: QueueItem[]
  skippedRelations: number
  skippedNodes: number
}

/** One unit of incremental index work: note files to (re)read, note files gone, and note stems whose image may have changed. */
interface IndexChangeSet {
  upsert: string[]
  remove: string[]
  imageStems: string[]
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
  /** noteStem -> newest matching filename in `images/`, rebuilt from a single directory scan each index. */
  private imagesByStem = new Map<string, string>()
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

    await this.stampNewlyPinned(pins)
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
    const now = new Date().toISOString()

    if (!request.relatedFilename) {
      await this.writeNoteFile(filename, { body: request.body, rels: [] })
      await this.stampTimestamps(filename, ['created', 'updated', 'opened'], now)
      await this.applyLocalChange({ upsert: [filename] })
      return { filename }
    }

    const label = (request.label ?? '').trim() || 'related'

    if (request.reverse) {
      await this.writeNoteFile(filename, {
        body: request.body,
        rels: [[label, request.relatedFilename]]
      })
    } else {
      await this.writeNoteFile(filename, { body: request.body, rels: [] })
      await this.appendRelation(request.relatedFilename, [label, filename])
    }

    // Both ends of the new relationship changed: the new note carries it (or is
    // its target), and the related note gained an edge in the other direction.
    await this.stampTimestamps(
      filename,
      ['created', 'updated', 'opened', 'relationshipsChanged'],
      now
    )
    await this.stampTimestamps(request.relatedFilename, ['relationshipsChanged'], now)

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
    // own raw JSON is: `undoDelete` needs to be able to fully restore the note,
    // image included, without a permanently-broken image reference.
    let image: PendingNoteImage | null = null
    if (existing.image) {
      try {
        const data = await readFile(this.imageFilePath(existing.image))
        image = { filename: existing.image, data }
      } catch (error) {
        const maybeError = error as NodeJS.ErrnoException
        if (maybeError.code !== 'ENOENT') {
          throw error
        }
      }
      await this.deleteImageFiles(this.stemOf(request.filename))
    }

    // Every surviving note wired to this one loses a relationship as it goes.
    const neighbors = this.relationNeighbors(request.filename).filter((name) =>
      this.notes.has(name)
    )
    const now = new Date().toISOString()
    for (const neighbor of neighbors) {
      await this.stampTimestamps(neighbor, ['relationshipsChanged'], now)
    }

    this.markSelfWrite(path)
    await unlink(path)
    this.pendingUndo = { type: 'note', filename: request.filename, raw, image, neighbors }
    await this.applyLocalChange({
      remove: [request.filename],
      upsert: neighbors,
      imageStems: existing.image ? [this.stemOf(request.filename)] : []
    })
  }

  async findOrphanedMedia(): Promise<{ count: number }> {
    await this.ensureIndexed()
    return { count: (await this.orphanedMediaFiles()).length }
  }

  async deleteOrphanedMedia(): Promise<{ deletedCount: number }> {
    await this.ensureIndexed()

    const orphanedFiles = await this.orphanedMediaFiles()
    await Promise.all(
      orphanedFiles.map(async (filename) => {
        const path = this.imageFilePath(filename)
        this.markSelfWrite(path)
        try {
          await unlink(path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error
          }
        }
      })
    )
    await this.scanImages()

    return { deletedCount: orphanedFiles.length }
  }

  async updateNote(request: UpdateNoteRequest): Promise<void> {
    await this.ensureIndexed()

    const existing = this.notes.get(request.filename)
    if (!existing) {
      throw new Error(`Could not find "${request.filename}" in ${this.graphPath}.`)
    }

    const contentChanged =
      existing.body !== request.body || existing.extraContent !== request.extraContent
    const now = new Date().toISOString()

    await this.mutateRawNote(request.filename, (parsed) => {
      parsed.body = request.body
      if (request.extraContent.trim().length > 0) {
        parsed.extra = request.extraContent
      } else {
        delete parsed.extra
      }
      if (contentChanged) {
        this.applyTimestampStamp(parsed, ['updated', 'opened'], now)
      }
    })

    await this.applyLocalChange({ upsert: [request.filename] })
  }

  /**
   * Writes `dataUrl`'s bytes to `images/<noteStem>-<epochMillis><ext>`, replacing
   * any image or video already attached to that note. The note JSON is untouched -
   * the link is by filename stem (see `../note`).
   */
  async attachImage(request: AttachImageRequest): Promise<AttachImageResponse> {
    await this.ensureIndexed()

    if (!this.notes.has(request.filename)) {
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

    const stem = this.stemOf(request.filename)
    await this.deleteImageFiles(stem)

    const image = `${stem}-${Date.now()}.${extension}`
    await mkdir(this.imagesDir(), { recursive: true })
    const imagePath = this.imageFilePath(image)
    this.markSelfWrite(imagePath)
    await writeFile(imagePath, Buffer.from(base64, 'base64'))

    await this.applyLocalChange({ imageStems: [stem] })
    return { image }
  }

  /** Removes whatever image is attached to the note (its `images/` file[s]); no-op if none. */
  async clearImage(request: ClearImageRequest): Promise<void> {
    await this.ensureIndexed()

    if (!this.notes.has(request.filename)) {
      throw new Error(`Could not find "${request.filename}" in ${this.graphPath}.`)
    }

    await this.deleteImageFiles(this.stemOf(request.filename))
    await this.applyLocalChange({ imageStems: [this.stemOf(request.filename)] })
  }

  async connectNotes(request: ConnectNotesRequest): Promise<ConnectNotesResponse> {
    await this.ensureIndexed()

    if (!this.notes.has(request.source)) {
      throw new Error(`Could not find "${request.source}" in ${this.graphPath}.`)
    }
    if (!this.notes.has(request.target)) {
      throw new Error(`Could not find "${request.target}" in ${this.graphPath}.`)
    }

    const label = request.label.trim() || 'related'
    await this.appendRelation(request.source, [label, request.target])

    const now = new Date().toISOString()
    await this.stampTimestamps(request.source, ['relationshipsChanged'], now)
    await this.stampTimestamps(request.target, ['relationshipsChanged'], now)

    await this.applyLocalChange({ upsert: [request.source, request.target] })

    return { label }
  }

  async updateRelationLabel(request: UpdateRelationRequest): Promise<void> {
    await this.ensureIndexed()
    await this.mutateRelations(request.source, (rels) => {
      const index = rels.findIndex(
        ([label, target]) => label === request.label && target === request.target
      )
      if (index === -1) {
        throw new Error(`Could not find that relationship in "${request.source}".`)
      }
      rels[index] = [request.nextLabel.trim() || request.label, request.target]
    })

    const now = new Date().toISOString()
    await this.stampTimestamps(request.source, ['relationshipsChanged'], now)
    if (this.notes.has(request.target)) {
      await this.stampTimestamps(request.target, ['relationshipsChanged'], now)
    }

    await this.applyLocalChange({ upsert: [request.source, request.target] })
  }

  async deleteRelation(request: DeleteRelationRequest): Promise<void> {
    let removed: NoteRelationTuple | null = null

    await this.mutateRelations(request.source, (rels) => {
      const index = rels.findIndex(
        ([label, target]) => label === request.label && target === request.target
      )
      if (index === -1) {
        throw new Error(`Could not find that relationship in "${request.source}".`)
      }
      removed = rels[index]
      rels.splice(index, 1)
    })

    const now = new Date().toISOString()
    await this.stampTimestamps(request.source, ['relationshipsChanged'], now)
    if (this.notes.has(request.target)) {
      await this.stampTimestamps(request.target, ['relationshipsChanged'], now)
    }

    this.pendingUndo = { type: 'relation', source: request.source, relation: removed! }
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
        await mkdir(this.imagesDir(), { recursive: true })
        const imagePath = this.imageFilePath(pending.image.filename)
        this.markSelfWrite(imagePath)
        await writeFile(imagePath, pending.image.data)
      }

      // The relationships that vanished with the note are back - re-stamp the
      // same set the delete stamped, plus the note itself now that it exists.
      const now = new Date().toISOString()
      const revived = pending.neighbors.filter((name) => this.notes.has(name))
      await this.stampTimestamps(pending.filename, ['relationshipsChanged'], now)
      for (const neighbor of revived) {
        await this.stampTimestamps(neighbor, ['relationshipsChanged'], now)
      }

      await this.applyLocalChange({
        upsert: [pending.filename, ...revived],
        imageStems: pending.image ? [this.stemOf(pending.filename)] : []
      })
    } else {
      await this.appendRelation(pending.source, pending.relation)

      const now = new Date().toISOString()
      const [, target] = pending.relation
      await this.stampTimestamps(pending.source, ['relationshipsChanged'], now)
      if (this.notes.has(target)) {
        await this.stampTimestamps(target, ['relationshipsChanged'], now)
      }

      await this.applyLocalChange({ upsert: [pending.source, target] })
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

    return selectRecentNotes(this.notes.values(), request.sort, request.page)
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

  async deleteNoteEntry(request: DeleteNoteEntryRequest): Promise<void> {
    await this.ensureIndexed()

    const existing = this.notes.get(request.filename)
    if (!existing) {
      throw new Error(`Could not find "${request.filename}" in ${this.graphPath}.`)
    }

    const now = new Date().toISOString()
    await this.mutateRawNote(request.filename, (parsed) => {
      const notes = Array.isArray(parsed.notes) ? (parsed.notes as unknown[]) : []
      if (request.index < 0 || request.index >= notes.length) {
        throw new Error(`Note index ${request.index} out of range for "${request.filename}".`)
      }
      notes.splice(request.index, 1)
      if (notes.length > 0) {
        parsed.notes = notes
      } else {
        delete parsed.notes
      }
      this.applyTimestampStamp(parsed, ['updated', 'opened'], now)
    })

    await this.applyLocalChange({ upsert: [request.filename] })
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
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
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
      this.message = `No JSON note files were found in ${this.graphPath}.`
      this.hasIndexed = true
      return
    }

    // Populated before notes are read - readNoteFile resolves each note's image from here.
    await this.scanImages()

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

    await this.repairDanglingRelations()

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
        remove: change.remove ?? [],
        imageStems: change.imageStems ?? []
      })
    )
  }

  /**
   * The single incremental-apply path, shared by in-app mutations, the watcher,
   * and the safety reconcile. Preserves the ordering `runFullIndex` relies on:
   * images -> notes+corpus -> scoped repair -> reverseRefs -> degree.
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
    if (touched === 0 && change.imageStems.length === 0) {
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
    const removedOrEmptied = new Set<string>()
    // Notes that did not exist before this batch - their appearance can un-break
    // a rel that was previously dropped as dangling.
    const newlyAdded = new Set<string>()
    // Notes that just regained a body - like newlyAdded, they can un-break a rel
    // that was previously dropped as dangling.
    const unEmptied = new Set<string>()
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
      if (prev && next && this.isEmptyBody(prev) && !this.isEmptyBody(next)) {
        unEmptied.add(filename)
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
      if (!next || this.isEmptyBody(next)) {
        removedOrEmptied.add(filename)
      }
    }

    // 1. Images first, so a re-read note resolves its current image.
    if (change.imageStems.length > 0) {
      await this.scanImages()
      for (const stem of new Set(change.imageStems)) {
        const filename = `${stem}.json`
        const note = this.notes.get(filename)
        if (note) {
          note.image = this.imagesByStem.get(stem) ?? null
          affected.add(filename)
        }
      }
    }

    // 2a. Read every upserted note into place (rels not yet repaired - a batch can
    //     contain both ends of a new relation, in any order).
    for (const filename of change.upsert) {
      await processUpsert(filename)
    }

    for (const filename of change.remove) {
      const prev = this.unindexNote(filename, delta)
      relSources.add(filename)
      affected.add(filename)
      removedOrEmptied.add(filename)
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

    // 2b. A note that just appeared (or regained a body) may make a previously
    //     dangling rel valid again - re-read those senders from disk.
    const reviveSources = new Set<string>()
    for (const filename of [...newlyAdded, ...unEmptied]) {
      for (const source of this.danglingRefSources.get(filename) ?? []) {
        reviveSources.add(source)
      }
      this.danglingRefSources.delete(filename)
    }
    for (const source of reviveSources) {
      await processUpsert(source)
    }

    // 3. Repair dangling rels: on every note just read (it may carry rels to
    //    missing/empty targets) and on every note that pointed at something just
    //    removed or emptied.
    const repairCandidates = new Set<string>([...relSources])
    for (const trigger of removedOrEmptied) {
      for (const incoming of this.reverseRefs.get(trigger) ?? []) {
        repairCandidates.add(incoming.source)
      }
    }
    const repaired = await this.repairRelsOf(repairCandidates)
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

    // 4. reverseRefs: rebuild every changed source's contributions.
    for (const source of relSources) {
      const current = this.notes.get(source)?.rels ?? []
      this.repatchReverseRefs(source, prevRelTargets.get(source) ?? [], current)
    }
    for (const filename of change.remove) {
      if ((this.reverseRefs.get(filename)?.length ?? 0) === 0) {
        this.reverseRefs.delete(filename)
      }
    }

    // 5. degree.
    this.repatchDegrees(affected)

    // 6. hand the search worker just the delta.
    this.postWorkerDelta(delta.upserts, delta.removals)

    // 7. one signal per batch.
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

    const upsert = [...batch.notes.added, ...batch.notes.changed].filter(notSelfWrite)
    const remove = batch.notes.removed.filter(notSelfWrite)

    const imageStems: string[] = []
    if (batch.images.touched) {
      for (const path of batch.images.paths) {
        if (this.consumeSelfWrite(path)) {
          continue
        }
        const parsed = this.parseImageName(basename(path))
        if (parsed) {
          imageStems.push(parsed.stem)
        }
      }
    }

    if (upsert.length === 0 && remove.length === 0 && imageStems.length === 0) {
      return
    }

    await this.enqueue(() => this.applyFileChanges({ upsert, remove, imageStems }))
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
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
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

    await this.enqueue(() =>
      this.applyFileChanges({ upsert: added, remove: removed, imageStems: [] })
    )
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

  private async readNoteFile(filename: string): Promise<IndexedNote | null> {
    try {
      const raw = await readFile(join(this.graphPath, filename), 'utf8')
      const parsed = JSON.parse(raw) as RawNoteFile
      const body = typeof parsed.body === 'string' ? parsed.body : ''
      const rels = Array.isArray(parsed.rels)
        ? parsed.rels.flatMap((rel) => this.normalizeRelation(rel))
        : []
      const image = this.imagesByStem.get(this.stemOf(filename)) ?? null
      const extraContent = typeof parsed.extra === 'string' ? parsed.extra : ''
      const notes = Array.isArray(parsed.notes)
        ? parsed.notes.filter((entry): entry is string => typeof entry === 'string')
        : []

      return {
        filename,
        body,
        bodyCompact: body.replace(/\s+/g, ' ').trim(),
        rels,
        degree: rels.length,
        image,
        extraContent,
        extraCompact: extraContent.replace(/\s+/g, ' ').trim(),
        notes,
        created: this.readTimestamp(parsed.created),
        updated: this.readTimestamp(parsed.updated),
        opened: this.readTimestamp(parsed.opened),
        relationshipsChanged: this.readTimestamp(parsed.relationshipsChanged)
      }
    } catch (error) {
      console.warn(`Skipping unreadable note ${filename}:`, error)
      return null
    }
  }

  private normalizeRelation(rel: unknown): NoteLink[] {
    if (!Array.isArray(rel) || rel.length < 2) {
      return []
    }

    const [label, target] = rel
    if (typeof label !== 'string' || typeof target !== 'string') {
      return []
    }

    return [{ label, target }]
  }

  /**
   * A relation can point at a target that no longer resolves to a real, non-empty
   * note - most often a note that was just deleted (still within its undo window),
   * or a note whose body was cleared out from under an existing relationship. Either
   * way it must never surface as a graph node/edge (see tckt/issues/do-not-show-broken-nodes.md).
   *
   * The two cases are handled differently on purpose:
   * - Missing target (deleted note): dropped from this in-memory pass only. Writing
   *   this removal back to disk would make `undoDelete` unable to fully restore the
   *   relationship if the delete is undone a moment later.
   * - Empty target (note exists but has no body): a durable state, not a race with an
   *   in-flight delete, so the relationship is actually stripped from the sender's
   *   file, matching the ticket's "auto-delete the relationship from sender note".
   */
  private async repairDanglingRelations(): Promise<void> {
    await this.repairRelsOf(this.notes.keys())
  }

  /**
   * Strips broken rels from each note in `candidates`: a missing target is dropped
   * in memory only (and remembered in `danglingRefSources` so it can be restored
   * if the target reappears); an existing but empty-bodied target is dropped from
   * memory and from disk. Returns each mutated note mapped to its rel targets
   * *before* the repair.
   */
  private async repairRelsOf(candidates: Iterable<string>): Promise<Map<string, string[]>> {
    const mutated = new Map<string, string[]>()
    const writes: Promise<void>[] = []

    for (const filename of candidates) {
      const note = this.notes.get(filename)
      if (!note) {
        continue
      }

      let relationToEmptyTarget = false
      const kept = note.rels.filter((rel) => {
        const target = this.notes.get(rel.target)
        if (!target) {
          this.recordDanglingSource(rel.target, filename)
          return false
        }
        if (this.isEmptyBody(target)) {
          relationToEmptyTarget = true
          return false
        }
        return true
      })

      if (kept.length === note.rels.length) {
        continue
      }

      mutated.set(
        filename,
        note.rels.map((rel) => rel.target)
      )
      note.rels = kept
      if (relationToEmptyTarget) {
        writes.push(this.persistRelations(filename, kept))
      }
    }

    await Promise.all(writes)
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

  private isEmptyBody(note: IndexedNote): boolean {
    return note.body.trim().length === 0
  }

  private async persistRelations(filename: string, rels: NoteLink[]): Promise<void> {
    await this.mutateRelations(filename, (raw) => {
      raw.length = 0
      raw.push(...rels.map((rel): NoteRelationTuple => [rel.label, rel.target]))
    })
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
    this.imagesByStem.clear()
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
   * it actually exists and has content. `repairDanglingRelations` already strips
   * empty-target relations from disk, and drops missing-target ones from this
   * in-memory pass, so this is mostly a defensive backstop plus the one case that
   * repair doesn't cover: an empty note that is itself the *source* of a relation
   * into some other, perfectly valid note.
   */
  private isRenderableNode(filename: string): boolean {
    const note = this.notes.get(filename)
    return note !== undefined && !this.isEmptyBody(note)
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
    // which filter out missing/empty targets via isRenderableNode before this runs.
    const note = this.notes.get(filename)!

    return {
      filename,
      body: note.body,
      image: note.image,
      extraContent: note.extraContent,
      depth: meta.depth,
      degree: note.degree,
      hiddenNeighbors: this.countHiddenNeighbors(note, shown),
      notes: note.notes,
      created: note.created,
      updated: note.updated,
      opened: note.opened,
      relationshipsChanged: note.relationshipsChanged
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
      candidate = `${slug}-${randomBytes(3).toString('hex')}.json`
    } while (this.notes.has(candidate))
    return candidate
  }

  private async writeNoteFile(
    filename: string,
    data: { body: string; rels: NoteRelationTuple[] }
  ): Promise<void> {
    const payload: RawNoteFile = { body: data.body, rels: data.rels }
    const path = join(this.graphPath, filename)
    this.markSelfWrite(path)
    await writeFile(path, JSON.stringify(payload, null, 2), 'utf8')
  }

  private async appendRelation(filename: string, relation: NoteRelationTuple): Promise<void> {
    await this.mutateRelations(filename, (rels) => {
      rels.push(relation)
    })
  }

  private readTimestamp(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null
  }

  /**
   * Writes `now` into each named lifecycle timestamp on an already-parsed note
   * body. `created` is write-once - a note that already carries one keeps it.
   * Operates on the parsed object so callers that are already inside a
   * `mutateRawNote` pass can stamp without a second read-modify-write.
   */
  private applyTimestampStamp(
    parsed: Record<string, unknown>,
    fields: readonly NoteTimestampField[],
    now: string
  ): void {
    for (const field of fields) {
      if (field === 'created' && this.readTimestamp(parsed.created)) {
        continue
      }
      parsed[field] = now
    }
  }

  /** Stamps lifecycle timestamps onto one note file, preserving every other key (see mutateRawNote). */
  private async stampTimestamps(
    filename: string,
    fields: readonly NoteTimestampField[],
    now: string
  ): Promise<void> {
    await this.mutateRawNote(filename, (parsed) => this.applyTimestampStamp(parsed, fields, now))
  }

  /**
   * Stamps `opened` on every note that is in `pins` but was not in the previous
   * pin set - i.e. the notes the user just opened onto the graph. Restoring a
   * persisted pin set on startup is not a fresh open, so it stamps nothing.
   */
  private async stampNewlyPinned(pins: PinSpec[]): Promise<void> {
    const alreadyPinned = new Set(this.lastPins.map((pin) => pin.filename))
    const freshlyPinned = pins
      .map((pin) => pin.filename)
      .filter((filename) => !alreadyPinned.has(filename) && this.notes.has(filename))
    if (freshlyPinned.length === 0) {
      return
    }

    // Best-effort: a failed timestamp write must never stop the graph from opening.
    try {
      const now = new Date().toISOString()
      for (const filename of freshlyPinned) {
        await this.stampTimestamps(filename, ['opened'], now)
      }
      await this.applyLocalChange({ upsert: freshlyPinned })
    } catch (error) {
      console.warn('Failed to stamp `opened` on newly pinned notes:', error)
    }
  }

  /** Every note wired directly to `filename` by an outgoing or an incoming relation. */
  private relationNeighbors(filename: string): string[] {
    const neighbors = new Set<string>()
    for (const rel of this.notes.get(filename)?.rels ?? []) {
      neighbors.add(rel.target)
    }
    for (const incoming of this.reverseRefs.get(filename) ?? []) {
      neighbors.add(incoming.source)
    }
    neighbors.delete(filename)
    return [...neighbors]
  }

  /** Reads, mutates, and rewrites a note's raw JSON in place, without disturbing fields this app doesn't otherwise read/write. */
  private async mutateRawNote(
    filename: string,
    mutate: (parsed: Record<string, unknown>) => void
  ): Promise<void> {
    const path = join(this.graphPath, filename)
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    mutate(parsed)
    this.markSelfWrite(path)
    await writeFile(path, JSON.stringify(parsed, null, 2), 'utf8')
  }

  private async mutateRelations(
    filename: string,
    mutate: (rels: NoteRelationTuple[]) => void
  ): Promise<void> {
    await this.mutateRawNote(filename, (parsed) => {
      const rels: NoteRelationTuple[] = Array.isArray(parsed.rels)
        ? (parsed.rels as NoteRelationTuple[])
        : []
      mutate(rels)
      parsed.rels = rels
    })
  }

  private imagesDir(): string {
    return join(this.graphPath, IMAGES_DIR_NAME)
  }

  private imageFilePath(filename: string): string {
    return join(this.imagesDir(), filename)
  }

  /** Resolves an indexed media filename without allowing traversal outside images/. */
  mediaFilePath(filename: string): string {
    const parsed = this.parseImageName(filename)
    if (
      filename !== basename(filename) ||
      !parsed ||
      this.imagesByStem.get(parsed.stem) !== filename
    ) {
      throw new Error('Unknown media file.')
    }
    return this.imageFilePath(filename)
  }

  /** `foo.json` -> `foo`. The stem an image filename must be prefixed with to belong to this note. */
  private stemOf(noteFilename: string): string {
    return noteFilename.replace(/\.json$/, '')
  }

  /** Lists `images/` (empty when the folder is absent). */
  private async listImageDir(): Promise<string[]> {
    try {
      return await readdir(this.imagesDir())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw error
    }
  }

  /** Recognized media files not selected as the live attachment of any indexed note. */
  private async orphanedMediaFiles(): Promise<string[]> {
    const liveMedia = new Set(
      [...this.notes.values()]
        .map((note) => note.image)
        .filter((filename): filename is string => filename !== null)
    )

    return (await this.listImageDir()).filter(
      (entry) => this.parseImageName(entry) !== null && !liveMedia.has(entry)
    )
  }

  /** `foo-1724900000000.webp` -> `{ stem: 'foo', ts: 1724900000000 }`, or null when it isn't a note's attached media. */
  private parseImageName(entry: string): { stem: string; ts: number } | null {
    const dot = entry.lastIndexOf('.')
    if (dot <= 0 || !SUPPORTED_MEDIA_EXTENSIONS.has(entry.slice(dot + 1).toLowerCase())) {
      return null
    }
    const stemMatch = IMAGE_STEM_PATTERN.exec(entry.slice(0, dot))
    return stemMatch ? { stem: stemMatch[1], ts: Number(stemMatch[2]) } : null
  }

  /** Single scan of `images/` into `imagesByStem`, keeping the newest timestamp per stem. */
  private async scanImages(): Promise<void> {
    this.imagesByStem.clear()

    const newestByStem = new Map<string, number>()
    for (const entry of await this.listImageDir()) {
      const parsed = this.parseImageName(entry)
      if (!parsed) {
        continue
      }
      const newest = newestByStem.get(parsed.stem)
      if (newest === undefined || parsed.ts > newest) {
        newestByStem.set(parsed.stem, parsed.ts)
        this.imagesByStem.set(parsed.stem, entry)
      }
    }
  }

  /** Deletes every `images/<stem>-<digits><ext>` file (current image plus any stale leftovers). */
  private async deleteImageFiles(stem: string): Promise<void> {
    await Promise.all(
      (await this.listImageDir())
        .filter((entry) => this.parseImageName(entry)?.stem === stem)
        .map(async (entry) => {
          const path = this.imageFilePath(entry)
          this.markSelfWrite(path)
          try {
            await unlink(path)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              throw error
            }
          }
        })
    )
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
