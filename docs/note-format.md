# Note file format

Each note is one `<slug>-<6 hex>.txt` file directly inside the graph folder,
written in the item language specified in the sibling
[`../dsl`](../../dsl/spec/language.md) repo. The folder's `.txt` files are the
database; there is no index or manifest.

```
Buy milk and eggs
from the corner shop

media images/buy-milk-and-eggs-a1b2c3-1758540000000.webp
-> for @pancake-recipe-0f1e2d
extra
Long-form content, shown in the extra-content modal.
```

What graphirst reads and writes:

| Part | Meaning |
| --- | --- |
| body | The note's text, shown on the graph node. Never empty. |
| `-> label @target` | An outgoing relationship. `target` is the other note's filename without `.txt`. A missing label is shown as `related`. |
| `media <path>` | The attached image or video, relative to the graph folder (see [media-attachments.md](./media-attachments.md)). |
| `extra` | Long-form content, from the `extra` line to the next keyword, relationship or state line, or the end of the file. Lines in it that would end it are indented when graphirst rewrites the file. |

Every other line (calendar keywords, unknown keywords, `( … )` state lines)
and the `data` block are kept as they are when graphirst rewrites a file; a
rewrite writes the section lines first, then `data`, then `extra`. The keyword schema is
vendored at `spec/keywords.yaml`; refresh it with `just sync-spec`.

## Identity

The filename is the note's id. Relationships, the pin list and the in-memory
index all refer to it. The name is generated once from the first words of the
body and never changes on edit; renaming a file outside the app breaks every
relationship pointing at it.

## Relationships

Only outgoing relationships are stored. Incoming ones are computed in memory.
A relationship to a note that isn't indexed (deleted, or a file with syntax
errors) is dropped from the in-memory graph only, so it comes back when the
target does.

## Invalid files

A file with syntax errors (see the spec's error codes) is skipped when
indexing, with a console warning. graphirst never rewrites such a file; fix it
in a text editor.

## Recent notes

The Recent tab orders notes by file modification time. graphirst doesn't
rewrite a file whose text an edit leaves unchanged, so that order stays
meaningful.

## Pins

Which notes are pinned onto the graph is not part of the note files. It lives
in `graphirst-settings.json` in the app's user-data directory:

```ts
interface StoredSettings {
  graphPath?: string
  pins?: PinSpec[] // { filename: string; depth: number }
}
```

## Key file references

- Parser and serializer: `src/main/dsl/`
- graphirst's reading of a note: `src/main/note-file.ts`
- Index and mutations: `src/main/note-store.ts`
