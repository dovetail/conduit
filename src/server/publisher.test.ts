import { describe, it, expect } from 'vitest'
import {
  resolveRunPublishMessage,
  selectPublishContent,
  splitSlackSections,
  buildFailureNotice,
  markdownToSlackMrkdwn,
  SLACK_SECTION_MAX_CHARS,
} from './publisher'

const SUMMARY = [
  '## Run Summary — AIA-607: Hoist route prefetch above subdomain gate',
  '',
  'Moved RoutePrefetchBootstrap above the subdomain gate.',
].join('\n')

describe('resolveRunPublishMessage', () => {
  it('returns the full output when no publish markers are present', () => {
    const stdout = ':chart_with_upwards_trend: *FE-Perf loop — advanced AIA-389*\nJob: advance-PR'
    expect(resolveRunPublishMessage(stdout)).toBe(stdout)
  })

  it('extracts the canonical publish block and drops surrounding narration', () => {
    const stdout = [
      'Starting the FE-perf loop.',
      'Draft PR created.',
      '<!--CONDUIT:PUBLISH-->',
      SUMMARY,
      '<!--/CONDUIT:PUBLISH-->',
      'Iteration complete.',
    ].join('\n')
    expect(resolveRunPublishMessage(stdout)).toBe(SUMMARY)
  })

  it('treats a repeated opening tag as a closer (FE-perf loop leak)', () => {
    const stdout = [
      'Starting the FE-perf loop. I will validate tooling.',
      'Yarn install succeeded.',
      '<!--CONDUIT:PUBLISH-->',
      SUMMARY,
      '<!--CONDUIT:PUBLISH-->',
    ].join('\n')
    expect(resolveRunPublishMessage(stdout)).toBe(SUMMARY)
  })

  it('accepts CONDUIT:END as a closer (Sentrypede loop-30 leak)', () => {
    const stdout = [
      'Starting a Sentry Patrol iteration.',
      'Now emitting the Phase 6 Slack summary.',
      '<!--CONDUIT:PUBLISH-->',
      '### Sentrypede — loop 30 (2026-08-02)',
      '*Scan:* 0 new issues.',
      '<!--CONDUIT:END-->',
      'Iteration complete. Summary: no new Sentry issues warranted action.',
    ].join('\n')
    expect(resolveRunPublishMessage(stdout)).toBe(
      '### Sentrypede — loop 30 (2026-08-02)\n*Scan:* 0 new issues.'
    )
  })

  it('accepts slash-after-colon and HTML-escaped comment forms', () => {
    const escaped = [
      'narration',
      '&lt;!--CONDUIT:PUBLISH--&gt;',
      'escaped summary',
      '&lt;!--/CONDUIT:PUBLISH--&gt;',
    ].join('\n')
    expect(resolveRunPublishMessage(escaped)).toBe('escaped summary')

    const slashAfter = '<!--CONDUIT:PUBLISH-->\nslash close\n<!--CONDUIT:/PUBLISH-->'
    expect(resolveRunPublishMessage(slashAfter)).toBe('slash close')
  })

  it('is tolerant of whitespace and case in the markers', () => {
    const stdout = '<!-- conduit:publish -->\nspaced\n<!-- /CONDUIT:publish -->'
    expect(resolveRunPublishMessage(stdout)).toBe('spaced')
  })

  it('uses content after an unclosed opener instead of the full transcript', () => {
    const stdout = [
      'Starting the FE-perf loop.',
      'Let me babysit CI.',
      '<!--CONDUIT:PUBLISH-->',
      SUMMARY,
    ].join('\n')
    expect(resolveRunPublishMessage(stdout)).toBe(SUMMARY)
    expect(resolveRunPublishMessage(stdout)).not.toContain('Starting the FE-perf loop')
  })

  it('prefers the last non-empty open block when the prompt is quoted earlier', () => {
    const stdout = [
      'To publish, wrap the summary in:',
      '<!--CONDUIT:PUBLISH-->',
      'Your formatted summary here',
      '<!--/CONDUIT:PUBLISH-->',
      'Done. Real summary follows.',
      '<!--CONDUIT:PUBLISH-->',
      'actual summary',
      '<!--/CONDUIT:PUBLISH-->',
    ].join('\n')
    expect(resolveRunPublishMessage(stdout)).toBe('actual summary')
  })

  it('skips publishing when an opener is present but the block is empty', () => {
    expect(resolveRunPublishMessage('<!--CONDUIT:PUBLISH-->\n<!--/CONDUIT:PUBLISH-->')).toBeNull()
    expect(resolveRunPublishMessage('<!--CONDUIT:PUBLISH-->\n<!--CONDUIT:PUBLISH-->')).toBeNull()
    expect(resolveRunPublishMessage('')).toBeNull()
  })
})

describe('selectPublishContent', () => {
  it('uses the publish block when one was emitted', () => {
    const messages = ['Starting.', `Done.\n\n<!--CONDUIT:PUBLISH-->\n${SUMMARY}`]
    expect(selectPublishContent(messages, 'FE bot')).toBe(SUMMARY)
  })

  it('posts only the labelled last message, not the transcript, when no block was emitted', () => {
    const messages = ['Starting the FE-perf loop.', 'Let me babysit CI.', 'Stopped the noisy monitor.']
    const content = selectPublishContent(messages, 'FE bot')!
    expect(content).toContain('FE bot finished without a publish summary')
    expect(content).toContain('Stopped the noisy monitor.')
    expect(content).not.toContain('Starting the FE-perf loop.')
  })

  it('returns null when there is nothing to post', () => {
    expect(selectPublishContent([], 'FE bot')).toBeNull()
    expect(selectPublishContent(['  '], 'FE bot')).toBeNull()
  })
})

describe('splitSlackSections', () => {
  it('keeps short text as one section', () => {
    expect(splitSlackSections('hello\n\nworld')).toEqual(['hello\n\nworld'])
  })

  it('splits a single oversized paragraph on line boundaries', () => {
    const bullet = '- ' + 'x'.repeat(398)
    const paragraph = Array.from({ length: 20 }, () => bullet).join('\n')
    const sections = splitSlackSections(paragraph)
    expect(sections.length).toBeGreaterThan(1)
    for (const s of sections) expect(s.length).toBeLessThanOrEqual(SLACK_SECTION_MAX_CHARS)
    expect(sections.join('\n')).toBe(paragraph)
  })

  it('hard-splits a single line longer than the section limit', () => {
    const line = 'y'.repeat(SLACK_SECTION_MAX_CHARS * 2 + 10)
    const sections = splitSlackSections(line)
    for (const s of sections) expect(s.length).toBeLessThanOrEqual(SLACK_SECTION_MAX_CHARS)
    expect(sections.join('')).toBe(line)
  })
})

describe('markdownToSlackMrkdwn', () => {
  it('escapes literal angle brackets so Slack renders them instead of garbling them', () => {
    // Regression: Sentinel's daily sweep described a sanitizer fix using
    // backtick-quoted `<set>` / `<animate>` tags. Sent unescaped, Slack's
    // API treats `<set>` as an attempted (invalid) special reference and
    // the client displays it back as the literal text "&lt;set&gt;".
    const input = 'Logos can include `<set>`, `<animate>` or `@import` payloads.'
    const result = markdownToSlackMrkdwn(input)
    expect(result).toBe('Logos can include `&lt;set&gt;`, `&lt;animate&gt;` or `@import` payloads.')
    expect(result).not.toContain('<set>')
  })

  it('escapes a bare ampersand', () => {
    expect(markdownToSlackMrkdwn('Rules & regulations')).toBe('Rules &amp; regulations')
  })

  it('converts markdown links and bold without double-escaping the generated syntax', () => {
    const input = 'See [PR #1](https://example.com/pr/1?a=1&b=2) for **details**.'
    expect(markdownToSlackMrkdwn(input)).toBe(
      'See <https://example.com/pr/1?a=1&amp;b=2|PR #1> for *details*.'
    )
  })

  it('lifts a URL out of inline code so Slack does not print angle brackets around it', () => {
    // Regression: the dependency-upgrade summary quoted an error as
    // `Bad credentials (https://api.github.com/graphql)`. Slack autolinks
    // the URL inside the code span, and the client then shows the literal
    // text "<https://api.github.com/graphql>".
    const input = 'failed with `HTTP 401: Bad credentials (https://api.github.com/graphql)` today'
    expect(markdownToSlackMrkdwn(input)).toBe(
      'failed with `HTTP 401: Bad credentials (`<https://api.github.com/graphql>`)` today'
    )
  })

  it('leaves a prose URL alone so Slack can autolink it', () => {
    expect(markdownToSlackMrkdwn('Draft: https://github.com/org/repo/pull/new/deps/pkg')).toBe(
      'Draft: https://github.com/org/repo/pull/new/deps/pkg'
    )
  })

  it('does not autolink or reformat a fenced sample', () => {
    const input = ['```', '- not a bullet', 'curl https://example.com/a', '```'].join('\n')
    const result = markdownToSlackMrkdwn(input)
    expect(result).toContain('- not a bullet')
    expect(result).not.toContain('• not a bullet')
    expect(result).toContain('https:\u200b//example.com/a')
    expect(result).not.toContain('<https')
  })

  it('turns markdown headings into Slack bold instead of leaving the hashes', () => {
    // Regression: the front-end performance summary opened with
    // "## Front-End Performance Loop — Run Summary", which Slack shows
    // with the hashes still visible.
    const input = [
      '## Front-End Performance Loop — Run Summary',
      '',
      '**Job executed:** Job 3 — Start next fix',
      '### Already **bold** title',
    ].join('\n')
    expect(markdownToSlackMrkdwn(input)).toBe(
      [
        '*Front-End Performance Loop — Run Summary*',
        '',
        '*Job executed:* Job 3 — Start next fix',
        '*Already bold title*',
      ].join('\n')
    )
  })

  it('does not rewrite a heading inside a fenced sample', () => {
    const input = ['```', '## not a heading', '```'].join('\n')
    expect(markdownToSlackMrkdwn(input)).toContain('## not a heading')
  })

  it('normalizes nested markdown lists to a stable Slack indent', () => {
    const input = [
      '- **Baseline: green.** checked',
      '  - nested detail',
      '  1. **Upgrade pkg**',
      '     - Branch: `deps/pkg`',
    ].join('\n')
    expect(markdownToSlackMrkdwn(input)).toBe(
      [
        '• *Baseline: green.* checked',
        '    • nested detail',
        '    1. *Upgrade pkg*',
        '        • Branch: `deps/pkg`',
      ].join('\n')
    )
  })
})

describe('buildFailureNotice', () => {
  it('names the agent, includes the reason, and links to the run', () => {
    const notice = buildFailureNotice(
      'FE bot',
      { id: 'run-1', agentId: 'agent-1', lastLine: '✗ Run process was killed (SIGKILL)' },
      'https://conduit.example'
    )
    // Canonical markdown — converted per-target (Slack/email), not Slack-native syntax.
    expect(notice).toContain('**FE bot**')
    expect(notice).toContain('killed (SIGKILL)')
    expect(notice).toContain('[View run](https://conduit.example/agents/agent-1/runs/run-1)')
    expect(markdownToSlackMrkdwn(notice)).toContain(
      '<https://conduit.example/agents/agent-1/runs/run-1|View run>'
    )
  })

  it('falls back to a generic reason when the run has no last line', () => {
    const notice = buildFailureNotice('FE bot', { id: 'r', agentId: 'a' }, 'http://localhost:7456')
    expect(notice).toContain('No failure reason was recorded')
  })
})
