import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { IndexProgress, NotesApi } from '../shared/notes'

const notesApi: NotesApi = {
  getBootstrap: () => ipcRenderer.invoke('notes:get-bootstrap'),
  search: (request) => ipcRenderer.invoke('notes:search', request),
  searchFilenames: (criteria, cap) => ipcRenderer.invoke('notes:search-filenames', criteria, cap),
  recentNotes: (request) => ipcRenderer.invoke('notes:recent-notes', request),
  openGraph: (pins) => ipcRenderer.invoke('notes:graph', pins),
  pickDirectory: () => ipcRenderer.invoke('notes:pick-directory'),
  createNote: (request) => ipcRenderer.invoke('notes:create', request),
  deleteNote: (request) => ipcRenderer.invoke('notes:delete', request),
  updateNote: (request) => ipcRenderer.invoke('notes:update', request),
  attachImage: (request) => ipcRenderer.invoke('notes:attach-image', request),
  clearImage: (request) => ipcRenderer.invoke('notes:clear-image', request),
  findOrphanedMedia: () => ipcRenderer.invoke('notes:find-orphaned-media'),
  deleteOrphanedMedia: () => ipcRenderer.invoke('notes:delete-orphaned-media'),
  getMediaDataUrl: (request) => ipcRenderer.invoke('notes:get-media-data-url', request),
  copyMedia: (request) => ipcRenderer.invoke('notes:copy-media', request),
  copyMediaPath: (request) => ipcRenderer.invoke('notes:copy-media-path', request),
  connectNotes: (request) => ipcRenderer.invoke('notes:connect', request),
  updateRelationLabel: (request) => ipcRenderer.invoke('notes:update-relation-label', request),
  deleteRelation: (request) => ipcRenderer.invoke('notes:delete-relation', request),
  randomOrphan: (request) => ipcRenderer.invoke('notes:random-orphan', request),
  randomNote: (request) => ipcRenderer.invoke('notes:random-note', request),
  deleteNoteEntry: (request) => ipcRenderer.invoke('notes:delete-note-entry', request),
  undoDelete: () => ipcRenderer.invoke('notes:undo-delete'),
  onChanged: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on('notes:changed', listener)
    return () => ipcRenderer.removeListener('notes:changed', listener)
  },
  onIndexProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: IndexProgress): void =>
      callback(progress)
    ipcRenderer.on('notes:index-progress', listener)
    return () => ipcRenderer.removeListener('notes:index-progress', listener)
  }
}

const api = {
  notes: notesApi
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  const target = window as typeof window & {
    electron: typeof electronAPI
    api: typeof api
  }
  target.electron = electronAPI
  target.api = api
}
