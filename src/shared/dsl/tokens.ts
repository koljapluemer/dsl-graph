export interface Token {
  /** The token's text; for a quoted token, its content without the quotes. */
  text: string
  /** Offset in the line, for keeping the rest of an unknown keyword's line raw. */
  start: number
  /** Offset just past the token in the line, closing quote included. */
  end: number
  quoted: boolean
}

/**
 * Whitespace-separated tokens. A token starting with `"` runs to the next
 * unescaped `"` (or the end of the line) and may contain spaces; `\"` inside it
 * is a literal quote.
 */
export function tokenize(line: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < line.length) {
    if (/\s/.test(line[i])) {
      i++
      continue
    }

    const start = i
    if (line[i] === '"') {
      let text = ''
      i++
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && line[i + 1] === '"') {
          text += '"'
          i += 2
        } else {
          text += line[i]
          i++
        }
      }
      i = Math.min(i + 1, line.length) // the closing quote
      tokens.push({ text, start, end: i, quoted: true })
    } else {
      while (i < line.length && !/\s/.test(line[i])) {
        i++
      }
      tokens.push({ text: line.slice(start, i), start, end: i, quoted: false })
    }
  }
  return tokens
}

/** The token form of `value`: quoted when it holds whitespace or starts with a quote. */
export function formatToken(value: string): string {
  return /\s/.test(value) || value.startsWith('"') ? `"${value.replace(/"/g, '\\"')}"` : value
}
