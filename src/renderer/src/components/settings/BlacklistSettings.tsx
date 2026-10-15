import { useEffect, useRef, useState } from 'react'
import TagInput from '../TagInput'
import type { Blacklist, BlacklistOptions } from '../../../../shared/notes'

/**
 * Settings section: the note types and tags this app ignores. Saving rebuilds
 * the index, which refreshes the graph and search through the changed event.
 */
export default function BlacklistSettings({
  onError
}: {
  onError: (error: Error) => void
}): React.JSX.Element | null {
  const [options, setOptions] = useState<BlacklistOptions | null>(null)
  const onErrorRef = useRef(onError)
  useEffect(() => {
    onErrorRef.current = onError
  })

  // Loaded once per opening of the settings; edits update it locally.
  useEffect(() => {
    let ignore = false
    window.api.notes.getBlacklistOptions().then(
      (loaded) => {
        if (!ignore) {
          setOptions(loaded)
        }
      },
      (error: Error) => onErrorRef.current(error)
    )
    return () => {
      ignore = true
    }
  }, [])

  if (!options) {
    return null
  }

  const { blacklist } = options
  // Blacklisted types no longer in the folder stay listed, so they can be removed.
  const types = [...new Set([...options.knownTypes, ...blacklist.types])].sort()

  const save = async (next: Blacklist): Promise<void> => {
    setOptions({ ...options, blacklist: next })
    try {
      await window.api.notes.setBlacklist(next)
    } catch (error) {
      onError(error as Error)
    }
  }

  const toggleType = (type: string): void => {
    const hidden = blacklist.types.includes(type)
    void save({
      ...blacklist,
      types: hidden ? blacklist.types.filter((other) => other !== type) : [...blacklist.types, type]
    })
  }

  return (
    <div className="mt-5 border-t border-base-300 pt-5">
      <span className="text-sm font-medium">Hidden types</span>
      {types.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {types.map((type) => (
            <button
              key={type}
              type="button"
              className={`badge cursor-pointer ${blacklist.types.includes(type) ? 'badge-neutral' : 'badge-outline'}`}
              aria-pressed={blacklist.types.includes(type)}
              onClick={() => toggleType(type)}
            >
              {type}
            </button>
          ))}
        </div>
      ) : (
        <p className="mt-1 text-sm text-base-content/70">No typed notes.</p>
      )}

      <span className="mt-4 block text-sm font-medium">Hidden tags</span>
      <div className="mt-2">
        <TagInput
          tags={blacklist.tags}
          suggestions={options.knownTags}
          onChange={(tags) => void save({ ...blacklist, tags })}
        />
      </div>
    </div>
  )
}
