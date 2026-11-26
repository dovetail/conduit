import { describe, expect, it } from 'vitest'
import { resolveRunPublishMessage, splitThreadedMessage } from '../publisher'
import { PUBLISH_CLOSE, PUBLISH_OPEN, PUBLISH_OUTPUT_GUIDE, THREAD_DIVIDER } from './publishOutput'

describe('publish output guide', () => {
  it('documents delimiters the publisher extracts, and nothing else', () => {
    expect(PUBLISH_OUTPUT_GUIDE).toContain(PUBLISH_OPEN)
    expect(PUBLISH_OUTPUT_GUIDE).toContain(PUBLISH_CLOSE)
    const sample = [
      'I looked at three files.',
      PUBLISH_OPEN,
      '**Done.** See [the PR](https://example.com/pr/1).',
      PUBLISH_CLOSE,
      'Stopping.',
    ].join('\n')
    expect(resolveRunPublishMessage(sample)).toBe('**Done.** See [the PR](https://example.com/pr/1).')
  })
})

describe('thread divider', () => {
  it('is documented in the guide and recognised by the publisher', () => {
    expect(PUBLISH_OUTPUT_GUIDE).toContain(THREAD_DIVIDER)
    expect(splitThreadedMessage(`Head\n${THREAD_DIVIDER}\nBody`)).toEqual({ headline: 'Head', thread: 'Body' })
  })
})
