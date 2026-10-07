import { useEffect, useReducer, useState } from 'react'
import { AlertTriangle, FolderOpen, LoaderCircle, Moon, Settings2, Sun, Trash2 } from 'lucide-react'
import GraphCanvas from './components/GraphCanvas'
import Sidebar from './components/sidebar/Sidebar'
import { INITIAL_SEARCH_STATE, searchReducer } from './components/sidebar/search-state'
import {
  MANUAL_PIN_DEPTH,
  PIN_ALL_CAP,
  PIN_ALL_DEPTH,
  SEARCH_RESULT_PIN_DEPTH,
  useNoteGraph
} from './hooks/useNoteGraph'
import { useNoteSearch } from './hooks/useNoteSearch'
import { useSearchHistory } from './hooks/useSearchHistory'
import { useTheme } from './hooks/useTheme'
import type { IndexProgress, NotesBootstrap } from '../../shared/notes'

function App(): React.JSX.Element {
  const [theme, setTheme] = useTheme()
  const [bootstrap, setBootstrap] = useState<NotesBootstrap | null>(null)
  const {
    graph,
    pins,
    loading: graphLoading,
    error: graphError,
    pinNote,
    pinNotes,
    unpinNote,
    setPinDepth,
    pinAtLeast,
    clearPins,
    refetch
  } = useNoteGraph()
  const [search, dispatchSearch] = useReducer(searchReducer, INITIAL_SEARCH_STATE)
  const searchHistory = useSearchHistory()
  const [bootLoading, setBootLoading] = useState(true)
  const [indexProgress, setIndexProgress] = useState<IndexProgress | null>(null)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mediaCleanupBusy, setMediaCleanupBusy] = useState(false)
  const [orphanedMediaCount, setOrphanedMediaCount] = useState<number | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [orphanBusy, setOrphanBusy] = useState(false)
  const [randomNoteBusy, setRandomNoteBusy] = useState(false)
  const [pinAllBusy, setPinAllBusy] = useState(false)
  const {
    results,
    total: searchTotal,
    loading: searchLoading
  } = useNoteSearch(search.criteria, {
    page: search.page,
    enabled: bootstrap?.status === 'ready',
    onError: (error) => setErrorMessage(error.message)
  })

  useEffect(() => {
    let ignore = false

    const bootstrapApp = async (): Promise<void> => {
      try {
        const state = await window.api.notes.getBootstrap()
        if (ignore) {
          return
        }

        setBootstrap(state)
        setErrorMessage(null)

        if (state.status === 'ready') {
          for (const pin of state.pins ?? []) {
            pinNote(pin.filename, pin.depth)
          }
        }
      } catch (error) {
        if (!ignore) {
          setErrorMessage((error as Error).message)
        }
      } finally {
        if (!ignore) {
          setBootLoading(false)
        }
      }
    }

    void bootstrapApp()

    return () => {
      ignore = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    return window.api.notes.onIndexProgress(setIndexProgress)
  }, [])

  const displayedError = errorMessage ?? graphError

  // The single place that reacts to "notes changed" - every mutation (delete, edit,
  // create, connect, relation change, undo, ...) funnels through the backend's one
  // rebuild-and-emit path, so this is the only refresh wiring any of them need,
  // instead of each call site remembering to poke the graph *and* the search results.
  useEffect(() => {
    return window.api.notes.onChanged(() => {
      refetch({ background: true })
    })
  }, [refetch])

  const handlePickDirectory = async (): Promise<void> => {
    const previousGraphPath = bootstrap?.graphPath
    setSettingsBusy(true)
    try {
      const state = await window.api.notes.pickDirectory()
      setBootstrap(state)
      setErrorMessage(null)

      // Only clear pins if the folder actually changed - the picker returns the
      // unchanged bootstrap state when the user cancels the dialog.
      if (state.graphPath !== previousGraphPath) {
        clearPins()
        setOrphanedMediaCount(null)
      }
    } catch (error) {
      setErrorMessage((error as Error).message)
    } finally {
      setSettingsBusy(false)
    }
  }

  const handleFindOrphanedMedia = async (): Promise<void> => {
    setMediaCleanupBusy(true)
    try {
      const result = await window.api.notes.findOrphanedMedia()
      setOrphanedMediaCount(result.count)
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage((error as Error).message)
    } finally {
      setMediaCleanupBusy(false)
    }
  }

  const handleDeleteOrphanedMedia = async (): Promise<void> => {
    setMediaCleanupBusy(true)
    try {
      const result = await window.api.notes.deleteOrphanedMedia()
      setOrphanedMediaCount(0)
      setErrorMessage(
        result.deletedCount === 1
          ? 'Deleted 1 orphaned media file.'
          : `Deleted ${result.deletedCount} orphaned media files.`
      )
    } catch (error) {
      setErrorMessage((error as Error).message)
    } finally {
      setMediaCleanupBusy(false)
    }
  }

  const handlePinRandomOrphan = async (): Promise<void> => {
    setOrphanBusy(true)
    try {
      const response = await window.api.notes.randomOrphan({ exclude: Array.from(pins.keys()) })
      if (response.filename) {
        pinNote(response.filename, MANUAL_PIN_DEPTH)
        setErrorMessage(null)
      } else {
        setErrorMessage('No unopened orphan notes left to pin.')
      }
    } catch (error) {
      setErrorMessage((error as Error).message)
    } finally {
      setOrphanBusy(false)
    }
  }

  const handleOpenRandomNote = async (): Promise<void> => {
    setRandomNoteBusy(true)
    try {
      const response = await window.api.notes.randomNote({ exclude: Array.from(pins.keys()) })
      if (response.filename) {
        pinNote(response.filename, MANUAL_PIN_DEPTH)
        setErrorMessage(null)
      } else {
        setErrorMessage('No unopened notes left to open.')
      }
    } catch (error) {
      setErrorMessage((error as Error).message)
    } finally {
      setRandomNoteBusy(false)
    }
  }

  const handlePinAllSearchResults = async (): Promise<void> => {
    setPinAllBusy(true)
    try {
      const { filenames, total } = await window.api.notes.searchFilenames(
        search.criteria,
        PIN_ALL_CAP
      )
      pinNotes(filenames, PIN_ALL_DEPTH)
      searchHistory.record(search.criteria.query)
      setErrorMessage(
        total > filenames.length
          ? `Pinned the first ${filenames.length} of ${total} matches.`
          : null
      )
    } catch (error) {
      setErrorMessage((error as Error).message)
    } finally {
      setPinAllBusy(false)
    }
  }

  const handleSelectSearchResult = (filename: string): void => {
    pinNote(filename, SEARCH_RESULT_PIN_DEPTH)
    searchHistory.record(search.criteria.query)
  }

  const handleOpenRandomSearchResult = (): void => {
    if (results.length === 0) {
      return
    }
    const result = results[Math.floor(Math.random() * results.length)]
    pinNote(result.filename, SEARCH_RESULT_PIN_DEPTH)
  }

  if (bootLoading) {
    const progressLabel =
      indexProgress && indexProgress.total > 0
        ? `Indexing notes… ${indexProgress.loaded.toLocaleString()} / ${indexProgress.total.toLocaleString()}`
        : 'Indexing notes…'

    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex items-center gap-3 rounded-full border border-base-300 bg-base-100 px-5 py-3 shadow-lg">
          <LoaderCircle className="size-5 animate-spin" />
          <span className="font-medium">{progressLabel}</span>
        </div>
      </div>
    )
  }

  return (
    <main className="h-screen">
      <div className="grid h-[calc(100vh-2rem)] grid-cols-[minmax(0,1fr)_22rem]">
        <section className="relative min-h-0">
          <div className="absolute right-4 top-4 z-20 flex flex-col gap-2">
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-square rounded-full border border-base-300 bg-base-100/90"
              onClick={() => setSettingsOpen(true)}
              title="Configure graph folder"
            >
              <Settings2 className="size-4" />
            </button>
          </div>

          {displayedError ? (
            <div className="alert alert-error alert-soft absolute left-1/2 top-4 z-20 max-w-md -translate-x-1/2 items-start shadow-lg">
              <AlertTriangle className="mt-0.5 size-4.5 shrink-0" />
              <p>{displayedError}</p>
            </div>
          ) : null}

          {bootstrap?.status === 'ready' ? (
            <GraphCanvas
              graph={graph}
              loading={graphLoading}
              colorMode={theme}
              pins={pins}
              onPinNote={pinNote}
              onUnpinNote={unpinNote}
              onSetPinDepth={setPinDepth}
              onPinAtLeast={pinAtLeast}
              onClearPins={clearPins}
              onPinRandomOrphan={() => void handlePinRandomOrphan()}
              pinRandomOrphanBusy={orphanBusy}
              onOpenRandomNote={() => void handleOpenRandomNote()}
              openRandomNoteBusy={randomNoteBusy}
              onOpenRandomSearchResult={handleOpenRandomSearchResult}
              openRandomSearchResultDisabled={results.length === 0}
              onPinAllSearchResults={() => void handlePinAllSearchResults()}
              pinAllSearchResultsDisabled={searchTotal === 0 || pinAllBusy}
            />
          ) : (
            <UnavailableState bootstrap={bootstrap} onOpenSettings={() => setSettingsOpen(true)} />
          )}
        </section>

        <Sidebar
          search={{
            state: search,
            dispatch: dispatchSearch,
            results,
            total: searchTotal,
            loading: searchLoading,
            history: searchHistory.history,
            onSelectNote: handleSelectSearchResult
          }}
          pins={pins}
          onSelectNote={(filename) => pinNote(filename, SEARCH_RESULT_PIN_DEPTH)}
          onError={(error) => setErrorMessage(error.message)}
        />
      </div>

      <dialog className={['modal', settingsOpen ? 'modal-open' : ''].join(' ')}>
        <div className="modal-box max-w-xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-xl font-semibold">Graph folder</h3>
              <p className="mt-2 text-sm leading-6 text-base-content/70">
                {bootstrap?.graphPath || 'No folder selected'}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm rounded-full"
              onClick={() => setSettingsOpen(false)}
            >
              Close
            </button>
          </div>

          <div className="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              className="btn btn-primary rounded-full"
              disabled={settingsBusy}
              onClick={() => void handlePickDirectory()}
            >
              <FolderOpen className="size-4" />
              Choose folder
            </button>
          </div>

          {bootstrap?.message ? (
            <div className="alert alert-warning alert-soft mt-5">{bootstrap.message}</div>
          ) : null}

          {bootstrap?.status === 'ready' ? (
            <div className="mt-5 flex items-center justify-between gap-4 border-t border-base-300 pt-5">
              <div>
                <span className="text-sm font-medium">Orphaned media</span>
                {orphanedMediaCount !== null ? (
                  <p className="mt-1 text-sm text-base-content/70">
                    {orphanedMediaCount === 1
                      ? '1 file is not attached to a note.'
                      : `${orphanedMediaCount} files are not attached to notes.`}
                  </p>
                ) : null}
              </div>
              {orphanedMediaCount && orphanedMediaCount > 0 ? (
                <button
                  type="button"
                  className="btn btn-error btn-outline btn-sm rounded-full"
                  disabled={mediaCleanupBusy}
                  onClick={() => void handleDeleteOrphanedMedia()}
                >
                  {mediaCleanupBusy ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                  Delete {orphanedMediaCount}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-outline btn-sm rounded-full"
                  disabled={mediaCleanupBusy}
                  onClick={() => void handleFindOrphanedMedia()}
                >
                  {mediaCleanupBusy ? <LoaderCircle className="size-4 animate-spin" /> : null}
                  Scan
                </button>
              )}
            </div>
          ) : null}

          <div className="mt-5 flex items-center justify-between border-t border-base-300 pt-5">
            <span className="text-sm font-medium">Theme</span>
            <label className="swap swap-rotate">
              <input
                type="checkbox"
                checked={theme === 'dark'}
                onChange={(event) => setTheme(event.target.checked ? 'dark' : 'light')}
              />
              <Sun className="swap-off size-4.5" />
              <Moon className="swap-on size-4.5" />
            </label>
          </div>
        </div>
        <form method="dialog" className="modal-backdrop">
          <button onClick={() => setSettingsOpen(false)}>close</button>
        </form>
      </dialog>
    </main>
  )
}

function UnavailableState({
  bootstrap,
  onOpenSettings
}: {
  bootstrap: NotesBootstrap | null
  onOpenSettings: () => void
}): React.JSX.Element {
  const title =
    bootstrap?.status === 'no-folder'
      ? 'Choose your notes folder'
      : bootstrap?.status === 'missing-directory'
        ? 'Graph folder not found'
        : bootstrap?.status === 'empty'
          ? 'No notes indexed yet'
          : 'Graph unavailable'

  const message = bootstrap?.message ?? 'Choose the folder that contains your JSON notes.'

  return (
    <div className="flex h-full items-center justify-center border border-dashed border-base-300 bg-base-100/70 px-8 text-center">
      <div className="max-w-lg space-y-4">
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">{title}</h2>
          <p className="text-sm leading-6 text-base-content/70">{message}</p>
        </div>
        <button type="button" className="btn btn-primary rounded-full" onClick={onOpenSettings}>
          <Settings2 className="size-4" />
          Configure graph folder
        </button>
      </div>
    </div>
  )
}

export default App
