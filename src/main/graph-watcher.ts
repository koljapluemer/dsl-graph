import { EventEmitter } from 'node:events'
import { isAbsolute, relative, sep } from 'node:path'
import { watch, type ChokidarOptions, type FSWatcher } from 'chokidar'
import { isNoteFilename } from './graph-fs'

/** Trailing debounce: how long the buffer waits for the next event before flushing. */
const DEFAULT_DEBOUNCE_MS = 150
/** Hard cap: a continuous event stream is flushed at least this often regardless of the debounce. */
const DEFAULT_MAX_BATCH_WAIT_MS = 1000
/** awaitWriteFinish: a file must keep the same size for this long before it counts as written. */
const DEFAULT_STABILITY_THRESHOLD_MS = 200
const DEFAULT_POLL_INTERVAL_MS = 50

/**
 * One coalesced description of which note files changed in the graph folder
 * since the last flush. Names are bare `*.txt` basenames, as NoteStore keys them.
 */
export interface GraphChangeBatch {
  added: string[]
  changed: string[]
  removed: string[]
}

export interface GraphWatcherOptions {
  debounceMs?: number
  maxBatchWaitMs?: number
  stabilityThresholdMs?: number
  pollIntervalMs?: number
}

type NoteEventKind = 'add' | 'change' | 'unlink'

interface GraphWatcherEvents {
  batch: [batch: GraphChangeBatch]
  error: [error: Error]
  ready: []
}

/**
 * Watches one graph folder - a flat set of `*.txt` note files - and emits
 * coalesced `batch` events describing what changed on disk. Media files aren't
 * watched: a note names its media in its own text, so a media change is a note
 * change. It translates filesystem events into batches and nothing more: it has no
 * knowledge of the note index, the search corpus, or how a batch is applied.
 */
export class GraphWatcher extends EventEmitter<GraphWatcherEvents> {
  private readonly debounceMs: number
  private readonly maxBatchWaitMs: number
  private readonly stabilityThresholdMs: number
  private readonly pollIntervalMs: number

  private watcher: FSWatcher | null = null
  private path: string | null = null
  private starting: Promise<void> | null = null

  private readonly added = new Set<string>()
  private readonly changed = new Set<string>()
  private readonly removed = new Set<string>()

  private debounceTimer: NodeJS.Timeout | null = null
  private capTimer: NodeJS.Timeout | null = null

  constructor(options: GraphWatcherOptions = {}) {
    super()
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.maxBatchWaitMs = options.maxBatchWaitMs ?? DEFAULT_MAX_BATCH_WAIT_MS
    this.stabilityThresholdMs = options.stabilityThresholdMs ?? DEFAULT_STABILITY_THRESHOLD_MS
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  }

  isWatching(): boolean {
    return this.watcher !== null
  }

  watchedPath(): string | null {
    return this.path
  }

  /**
   * Begins (or moves) the watch to `graphPath`. Resolves once the initial
   * directory scan has completed. Idempotent for an unchanged path.
   */
  async start(graphPath: string): Promise<void> {
    if (this.path === graphPath && (this.watcher || this.starting)) {
      return this.starting ?? Promise.resolve()
    }

    await this.stop()
    this.path = graphPath

    const options: ChokidarOptions = {
      persistent: true,
      ignoreInitial: true,
      // Notes live directly inside the graph folder.
      depth: 0,
      awaitWriteFinish: {
        stabilityThreshold: this.stabilityThresholdMs,
        pollInterval: this.pollIntervalMs
      },
      ignored: (candidate: string) => this.isIgnored(graphPath, candidate)
    }

    const watcher = watch(graphPath, options)
    this.watcher = watcher

    watcher.on('add', (p) => this.onNoteEvent('add', graphPath, p))
    watcher.on('change', (p) => this.onNoteEvent('change', graphPath, p))
    watcher.on('unlink', (p) => this.onNoteEvent('unlink', graphPath, p))
    watcher.on('error', (error) => this.emit('error', error as Error))

    this.starting = new Promise<void>((resolve) => {
      watcher.once('ready', () => {
        this.starting = null
        this.emit('ready')
        resolve()
      })
    })
    return this.starting
  }

  /** Closes the watcher and drops any buffered, un-flushed events. */
  async stop(): Promise<void> {
    this.clearTimers()
    this.discardBuffer()
    this.path = null
    this.starting = null

    const watcher = this.watcher
    this.watcher = null
    if (watcher) {
      await watcher.close()
    }
  }

  /**
   * chokidar consults this for every path it encounters, directories included, so
   * the graph root must be allowed through for its contents to be walked at all.
   */
  private isIgnored(graphPath: string, candidate: string): boolean {
    return candidate !== graphPath && noteName(graphPath, candidate) === null
  }

  private onNoteEvent(kind: NoteEventKind, graphPath: string, absPath: string): void {
    const name = noteName(graphPath, absPath)
    if (!name) {
      return
    }

    this.reconcileNoteEvent(kind, name)
    this.scheduleFlush()
  }

  /** Folds a raw event into the pending buffer, collapsing add/change/unlink churn on one file. */
  private reconcileNoteEvent(kind: NoteEventKind, name: string): void {
    switch (kind) {
      case 'add':
        if (this.removed.delete(name)) {
          this.changed.add(name)
        } else {
          this.added.add(name)
        }
        return
      case 'change':
        if (!this.added.has(name)) {
          this.changed.add(name)
        }
        return
      case 'unlink':
        this.changed.delete(name)
        // A file created and destroyed within one batch never existed as far as
        // consumers are concerned - drop it entirely rather than reporting it.
        if (!this.added.delete(name)) {
          this.removed.add(name)
        }
        return
    }
  }

  private scheduleFlush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = setTimeout(() => this.flush(), this.debounceMs)
    if (!this.capTimer) {
      this.capTimer = setTimeout(() => this.flush(), this.maxBatchWaitMs)
    }
  }

  private flush(): void {
    this.clearTimers()
    if (!this.hasBufferedChanges()) {
      return
    }

    const batch: GraphChangeBatch = {
      added: [...this.added].sort(),
      changed: [...this.changed].sort(),
      removed: [...this.removed].sort()
    }
    this.discardBuffer()
    this.emit('batch', batch)
  }

  private hasBufferedChanges(): boolean {
    return this.added.size > 0 || this.changed.size > 0 || this.removed.size > 0
  }

  private clearTimers(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.capTimer) {
      clearTimeout(this.capTimer)
      this.capTimer = null
    }
  }

  private discardBuffer(): void {
    this.added.clear()
    this.changed.clear()
    this.removed.clear()
  }
}

/** The note basename an absolute path stands for, or null when it isn't a note file directly inside the graph folder. */
function noteName(graphPath: string, absPath: string): string | null {
  const name = relative(graphPath, absPath)
  if (!name || name.startsWith('..') || isAbsolute(name) || name.includes(sep)) {
    return null
  }
  return isNoteFilename(name) ? name : null
}
