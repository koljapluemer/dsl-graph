import { useRecentNotes } from '../../hooks/useRecentNotes'
import NoteListItem from './NoteListItem'
import PagedNoteList from './PagedNoteList'

export interface RecentTabProps {
  page: number
  onPageChange: (page: number) => void
  pins: ReadonlyMap<string, number>
  onSelectNote: (filename: string) => void
  onError: (error: Error) => void
}

export default function RecentTab({
  page,
  onPageChange,
  pins,
  onSelectNote,
  onError
}: RecentTabProps): React.JSX.Element {
  const { results, total, loading } = useRecentNotes(page, onError)

  return (
    <>
      <PagedNoteList
        page={page}
        total={total}
        loading={loading}
        onPageChange={onPageChange}
        emptyMessage="No recent notes."
      >
        {results.map((note) => (
          <NoteListItem
            key={note.filename}
            preview={note.preview}
            isPinned={pins.has(note.filename)}
            onSelect={() => onSelectNote(note.filename)}
          />
        ))}
      </PagedNoteList>
    </>
  )
}
