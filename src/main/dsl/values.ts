import type { ValueType } from './schema'
import type { Token } from './tokens'

const WEEKDAYS = new Set(['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'])
const DATE = /^(\d{2})-(\d{2})-(\d{2})$/
const MONTH = /^(\d{2})-(\d{2})$/

/** Whether the token is a value of any of `types`. Only a `path` may be quoted. */
export function matchesValueType(token: Token, types: readonly ValueType[]): boolean {
  return types.some((type) => (token.quoted ? type === 'path' : true) && matches(token.text, type))
}

function matches(text: string, type: ValueType): boolean {
  switch (type) {
    case 'date':
      return isDate(text)
    case 'month':
      return isMonth(text)
    case 'weekday':
      return WEEKDAYS.has(text)
    case 'path':
      return isPath(text)
    case 'text':
      return text.length > 0
  }
}

/** `yy-mm-dd`, year 20yy, only when it's a real calendar date. */
function isDate(text: string): boolean {
  const match = DATE.exec(text)
  if (!match) {
    return false
  }
  const [year, month, day] = [2000 + Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function isMonth(text: string): boolean {
  const match = MONTH.exec(text)
  return match !== null && Number(match[2]) >= 1 && Number(match[2]) <= 12
}

/** Relative to the item's folder: not empty, no leading `/`, no `\`, no `..` segment. */
function isPath(text: string): boolean {
  return (
    text.length > 0 &&
    !text.startsWith('/') &&
    !text.includes('\\') &&
    !text.split('/').includes('..')
  )
}
