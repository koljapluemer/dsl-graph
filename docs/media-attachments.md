# Note media attachments (images and video)

Each note may have one attached media file: an image or a short video.

## On-disk contract

- The note names its attachment in a `media` line (see the item language's
  `keywords.yaml`), with a path relative to the graph folder:
  `media images/my-note-a1b2c3-1758540000000.webp`. A path with spaces is
  quoted.
- graphirst writes attachments into `<graphFolder>/images/`, named
  `<noteStem>-<epochMillis>.<ext>`. The name only keeps files unique; nothing
  reads meaning from it.
- A hand-written `media` line may point anywhere inside the graph folder.
- When an attachment is replaced or cleared, or its note deleted, graphirst
  deletes the old file only if it is directly inside `images/` and no other
  note references it.
- "Orphaned media" are media files in `images/` that no note references.

## Recognised extensions

| Kind  | Extensions              |
| ----- | ------------------------ |
| Image | `jpg`, `jpeg`, `png`, `gif`, `webp`, `bmp` |
| Video | `mp4`, `webm`, `mov`      |

The extension alone decides whether it is an image or a video (see
`src/shared/media.ts:isVideoFilename`).

## Size expectations

Videos are meant to be short clips. graphirst caps an attached video's size
and does not transcode it, unlike images, which are downscaled and re-encoded
client side. Readers should not assume video files are small.
