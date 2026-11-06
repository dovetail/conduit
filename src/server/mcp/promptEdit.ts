import { ClientError } from '../errors'

export interface PromptEditResult {
  prompt: string
  replacements: number
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count++
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/**
 * Exact-string replacement within a prompt. Without `replaceAll` the old text
 * must occur exactly once, so an edit never lands somewhere the caller didn't
 * intend.
 */
export function applyPromptEdit(
  prompt: string,
  oldText: string,
  newText: string,
  replaceAll = false
): PromptEditResult {
  if (!oldText) throw new ClientError('oldText must not be empty.')
  if (oldText === newText) throw new ClientError('oldText and newText are identical.')
  const occurrences = countOccurrences(prompt, oldText)
  if (occurrences === 0) {
    throw new ClientError(
      'oldText was not found in the prompt. Fetch the current prompt and copy the text exactly (including whitespace).'
    )
  }
  if (occurrences > 1 && !replaceAll) {
    throw new ClientError(
      `oldText occurs ${occurrences} times. Include more surrounding text to make it unique, or set replaceAll.`
    )
  }
  return { prompt: prompt.split(oldText).join(newText), replacements: occurrences }
}

/** Compact line-level summary of how two prompt versions differ. */
export function summarizePromptDiff(before: string, after: string): string {
  const a = before.split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--
    endB--
  }
  if (start > endA && start > endB) return 'No changes.'
  const removed = a.slice(start, endA + 1).map((l) => `- ${l}`)
  const added = b.slice(start, endB + 1).map((l) => `+ ${l}`)
  return [`@@ line ${start + 1} @@`, ...removed, ...added].join('\n')
}
