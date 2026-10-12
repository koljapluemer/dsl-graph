/**
 * Layout constants for a graph folder, shared by the note index (NoteStore) and
 * the filesystem watcher (GraphWatcher) so the two agree on exactly which files
 * on disk are part of the graph.
 */
import {
  SUPPORTED_IMAGE_EXTENSIONS,
  SUPPORTED_MEDIA_EXTENSIONS,
  SUPPORTED_VIDEO_EXTENSIONS
} from '../shared/media'

/** Subdirectory of the graph folder this app writes attached media (an image or a short video) into. */
export const IMAGES_DIR_NAME = 'images'

/** Every note is one `<stem>.txt` item file directly inside the graph folder. */
export const NOTE_EXTENSION = '.txt'

export { SUPPORTED_IMAGE_EXTENSIONS, SUPPORTED_VIDEO_EXTENSIONS, SUPPORTED_MEDIA_EXTENSIONS }

/** Whether a file directly inside the graph folder is a note (dotfiles are temp files of other writers). */
export function isNoteFilename(name: string): boolean {
  return !name.startsWith('.') && name.toLowerCase().endsWith(NOTE_EXTENSION)
}
