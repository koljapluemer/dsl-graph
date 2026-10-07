import {
  app,
  shell,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  net,
  protocol
} from 'electron'
import { basename, join } from 'path'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { NOTES_CHANGED_EVENT, NOTES_INDEX_PROGRESS_EVENT, NoteStore } from './note-store'
import type {
  AttachImageRequest,
  ClearImageRequest,
  ConnectNotesRequest,
  CopyMediaRequest,
  CreateNoteRequest,
  DeleteNoteEntryRequest,
  DeleteNoteRequest,
  DeleteRelationRequest,
  IndexProgress,
  MediaFileRequest,
  NotesSearchRequest,
  PinSpec,
  RandomNoteRequest,
  RandomOrphanRequest,
  RecentNotesRequest,
  SearchCriteria,
  UpdateNoteRequest,
  UpdateRelationRequest
} from '../shared/notes'

const MEDIA_PROTOCOL = 'media'
const MEDIA_MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime'
}

// Must run before app 'ready' - registers the scheme itself as privileged
// (fetchable, CSP-friendly) so protocol.handle can serve real responses for it below.
// `stream: true` is required for <video>/<audio> to work at all on a custom scheme -
// without it Chromium expects a fully-buffered response and silently delivers
// nothing to the media element (no network error, just a black/unplayable player);
// <img> works either way, which is why only video was ever affected.
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_PROTOCOL,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

// Chromium doesn't request server-side decorations on native Wayland by default,
// so compositors like Mutter have no title bar/border to attach minimize, maximize,
// edge-resize, or keyboard tiling to. Must be set before app 'ready'.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations')
}

/** How often to run the drift-recovery reconcile while a window is open. */
const RECONCILE_INTERVAL_MS = 5 * 60_000
/** Minimum gap between focus-triggered reconciles, so rapid window switching isn't a scan storm. */
const RECONCILE_FOCUS_THROTTLE_MS = 10_000

let noteStore: NoteStore
let lastReconcileAt = 0

/** Best-effort: recover from any filesystem event the OS dropped. Cheap and idempotent. */
function requestReconcile(): void {
  if (!noteStore) {
    return
  }
  const now = Date.now()
  if (now - lastReconcileAt < RECONCILE_FOCUS_THROTTLE_MS) {
    return
  }
  lastReconcileAt = now
  void noteStore.reconcile()
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1680,
    height: 1040,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f6f0e8',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.maximize()
    mainWindow.show()
  })

  mainWindow.on('focus', requestReconcile)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')
  noteStore = new NoteStore(app.getPath('userData'))

  // Single fan-out point for "the note index changed" - every renderer-side view
  // (graph, search, ...) subscribes to this instead of individual mutations having
  // to remember which views need poking (see tckt/issues/sidebar-out-of-sync-with-true-note-state.md).
  noteStore.on(NOTES_CHANGED_EVENT, () => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('notes:changed')
    }
  })

  noteStore.on(NOTES_INDEX_PROGRESS_EVENT, (progress: IndexProgress) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('notes:index-progress', progress)
    }
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  setInterval(requestReconcile, RECONCILE_INTERVAL_MS).unref()

  // Serves note-attached media (an image or video) straight out of <graphPath>/images - reads the graph
  // path fresh on every request (rather than capturing it once) since it can change
  // at runtime via pickDirectory/setGraphPath. The filename rides in the URL path,
  // not the authority: image files inherit their note's filename stem, which is
  // routinely not a valid URL host (leading `-`, spaces, uppercase, …). basename
  // also collapses any `../` traversal the path might carry.
  //
  // Fetches through net.fetch on a file:// URL (rather than fs.readFile + a plain
  // 200 Response) so the Range header a <video> element sends is honored with a
  // real 206 Partial Content response - a manual full-body read breaks video
  // seeking, and some Chromium versions refuse to play the source at all without
  // it (see https://github.com/electron/electron/issues/38749).
  protocol.handle(MEDIA_PROTOCOL, async (request) => {
    const filename = basename(decodeURIComponent(new URL(request.url).pathname))
    const extension = filename.split('.').pop()?.toLowerCase() ?? ''
    const mimeType = MEDIA_MIME_TYPES[extension]

    if (!filename || !mimeType) {
      return new Response(null, { status: 404 })
    }

    const graphPath = noteStore.getCurrentPath()
    if (!graphPath) {
      return new Response(null, { status: 404 })
    }

    const fileUrl = pathToFileURL(join(graphPath, 'images', filename)).toString()
    try {
      const response = await net.fetch(fileUrl, { headers: request.headers })
      if (!response.ok && response.status !== 206) {
        console.warn(`Media fetch for "${fileUrl}" returned ${response.status}.`)
      }
      const headers = new Headers(response.headers)
      headers.set('content-type', mimeType)
      return new Response(response.body, { status: response.status, headers })
    } catch (error) {
      console.warn(`Media fetch for "${fileUrl}" threw:`, error)
      return new Response(null, { status: 404 })
    }
  })

  ipcMain.handle('notes:get-bootstrap', async () => {
    await noteStore.loadSettings()
    return noteStore.getBootstrap()
  })

  ipcMain.handle('notes:search', async (_event, request: NotesSearchRequest) => {
    return noteStore.search(request)
  })

  ipcMain.handle(
    'notes:search-filenames',
    async (_event, criteria: SearchCriteria, cap: number) => {
      return noteStore.searchFilenames(criteria, cap)
    }
  )

  ipcMain.handle('notes:graph', async (_event, pins: PinSpec[]) => {
    return noteStore.openGraph(pins)
  })

  ipcMain.handle('notes:create', async (_event, request: CreateNoteRequest) => {
    return noteStore.createNote(request)
  })

  ipcMain.handle('notes:delete', async (_event, request: DeleteNoteRequest) => {
    return noteStore.deleteNote(request)
  })

  ipcMain.handle('notes:update', async (_event, request: UpdateNoteRequest) => {
    return noteStore.updateNote(request)
  })

  ipcMain.handle('notes:attach-image', async (_event, request: AttachImageRequest) => {
    return noteStore.attachImage(request)
  })

  ipcMain.handle('notes:clear-image', async (_event, request: ClearImageRequest) => {
    return noteStore.clearImage(request)
  })

  ipcMain.handle('notes:find-orphaned-media', async () => {
    return noteStore.findOrphanedMedia()
  })

  ipcMain.handle('notes:delete-orphaned-media', async () => {
    return noteStore.deleteOrphanedMedia()
  })

  ipcMain.handle('notes:get-media-data-url', async (_event, request: MediaFileRequest) => {
    const path = noteStore.mediaFilePath(request.image)
    const extension = request.image.split('.').pop()?.toLowerCase() ?? ''
    const mimeType = MEDIA_MIME_TYPES[extension]
    if (!mimeType?.startsWith('image/')) {
      throw new Error('The media file is not an image.')
    }

    const data = await readFile(path)
    return `data:${mimeType};base64,${data.toString('base64')}`
  })

  ipcMain.handle('notes:copy-media', (_event, request: CopyMediaRequest) => {
    const match = /^data:image\/png;base64,(.+)$/.exec(request.pngDataUrl)
    if (!match) {
      throw new Error('Invalid clipboard image data.')
    }

    const image = nativeImage.createFromBuffer(Buffer.from(match[1], 'base64'))
    if (image.isEmpty()) {
      throw new Error('The clipboard PNG could not be read.')
    }
    clipboard.writeImage(image)
  })

  ipcMain.handle('notes:copy-media-path', (_event, request: MediaFileRequest) => {
    clipboard.writeText(noteStore.mediaFilePath(request.image))
  })

  ipcMain.handle('notes:connect', async (_event, request: ConnectNotesRequest) => {
    return noteStore.connectNotes(request)
  })

  ipcMain.handle('notes:update-relation-label', async (_event, request: UpdateRelationRequest) => {
    return noteStore.updateRelationLabel(request)
  })

  ipcMain.handle('notes:delete-relation', async (_event, request: DeleteRelationRequest) => {
    return noteStore.deleteRelation(request)
  })

  ipcMain.handle('notes:random-orphan', async (_event, request: RandomOrphanRequest) => {
    return noteStore.randomOrphan(request)
  })

  ipcMain.handle('notes:random-note', async (_event, request: RandomNoteRequest) => {
    return noteStore.randomNote(request)
  })

  ipcMain.handle('notes:recent-notes', async (_event, request: RecentNotesRequest) => {
    return noteStore.recentNotes(request)
  })

  ipcMain.handle('notes:delete-note-entry', async (_event, request: DeleteNoteEntryRequest) => {
    return noteStore.deleteNoteEntry(request)
  })

  ipcMain.handle('notes:undo-delete', async () => {
    return noteStore.undoDelete()
  })

  ipcMain.handle('notes:pick-directory', async () => {
    const selection = await dialog.showOpenDialog({
      title: 'Choose graph folder',
      defaultPath: noteStore.getCurrentPath() || app.getPath('home'),
      properties: ['openDirectory', 'createDirectory']
    })

    if (selection.canceled || selection.filePaths.length === 0) {
      return noteStore.getBootstrap()
    }

    return noteStore.setGraphPath(selection.filePaths[0])
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  void noteStore?.dispose()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
