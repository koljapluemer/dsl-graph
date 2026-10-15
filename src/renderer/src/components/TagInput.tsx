import { X } from 'lucide-react'
import { useId, useState } from 'react'

const TAG = /^[a-z0-9-]+$/

/**
 * Removable tag badges and a field that adds a tag on Enter, space or comma,
 * suggesting from `suggestions`. Input is lowercased; anything that isn't a
 * valid tag (`a-z`, `0-9`, `-`) is not added.
 */
export default function TagInput({
  tags,
  suggestions,
  onChange
}: {
  tags: string[]
  suggestions: string[]
  onChange: (tags: string[]) => void
}): React.JSX.Element {
  const listId = useId()
  const [draft, setDraft] = useState('')
  const [invalid, setInvalid] = useState(false)

  const add = (raw: string): void => {
    const tag = raw.trim().toLowerCase()
    if (!tag) {
      return
    }
    if (!TAG.test(tag)) {
      setInvalid(true)
      return
    }
    setDraft('')
    setInvalid(false)
    if (!tags.includes(tag)) {
      onChange([...tags, tag].sort())
    }
  }

  return (
    <div>
      {tags.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <span key={tag} className="badge badge-neutral gap-1">
              {tag}
              <button
                type="button"
                className="cursor-pointer opacity-70 hover:opacity-100"
                onClick={() => onChange(tags.filter((other) => other !== tag))}
                title={`Remove ${tag}`}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <input
        className={`input input-sm w-full ${invalid ? 'input-error' : ''}`}
        list={listId}
        value={draft}
        placeholder="Add tag"
        onChange={(event) => {
          const value = event.target.value
          setInvalid(false)
          if (/[\s,]$/.test(value)) {
            add(value.slice(0, -1))
          } else {
            setDraft(value)
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            add(draft)
          } else if (event.key === 'Backspace' && !draft && tags.length > 0) {
            onChange(tags.slice(0, -1))
          }
        }}
      />
      <datalist id={listId}>
        {suggestions
          .filter((tag) => !tags.includes(tag))
          .map((tag) => (
            <option key={tag} value={tag} />
          ))}
      </datalist>
    </div>
  )
}
