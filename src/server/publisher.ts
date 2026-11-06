import * as crypto from 'crypto'
import type { ExecutionRun, SlackPublishConfig, EmailPublishConfig, WebhookPublishConfig, PublishTargetType, PublishConfig, PublishTargetHealthResult } from '../shared/types'
import { getPublishTarget } from '../main/db/queries/publishTargets'
import { getAgent } from '../main/db/queries/agents'
import { readRunOutputMessages } from './utils'

/**
 * Publish target is a dumb delivery channel — the agent controls the content.
 *
 * Convention: if the agent's stdout contains a publish block, only that
 * content is posted. Canonical delimiters:
 *   <!--CONDUIT:PUBLISH-->
 *   ...content...
 *   <!--/CONDUIT:PUBLISH-->
 *
 * Parsing is intentionally forgiving: HTML-escaped comments, extra
 * whitespace, `<!--CONDUIT:END-->`, and a repeated opening tag as a closer
 * all count. Once an opening marker is present the surrounding narration is
 * never used as a fallback — a malformed block skips publishing rather than
 * dumping the full run.
 *
 * Agents that never emit a publish marker deliver only their last message,
 * labelled as such — never the whole transcript. Failed runs post a short
 * failure notice instead of their output.
 */

const PUBLISH_MARKER_RE =
  /(?:<!--|&lt;!--)\s*(\/?)\s*CONDUIT\s*:\s*(\/?)\s*(PUBLISH|END)\s*(?:-->|--&gt;)/gi

interface PublishMarker {
  index: number
  end: number
  kind: 'open' | 'close'
}

function findPublishMarkers(text: string): PublishMarker[] {
  const markers: PublishMarker[] = []
  const re = new RegExp(PUBLISH_MARKER_RE.source, 'gi')
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const slashBefore = match[1] === '/'
    const slashAfter = match[2] === '/'
    const name = match[3].toUpperCase()
    const kind: PublishMarker['kind'] =
      name === 'END' || slashBefore || slashAfter ? 'close' : 'open'
    markers.push({ index: match.index, end: match.index + match[0].length, kind })
    if (match[0].length === 0) re.lastIndex += 1
  }
  return markers
}

/**
 * Text to deliver to publish targets, or `null` to skip delivery.
 *
 * Exported for unit tests.
 */
export function resolveRunPublishMessage(stdout: string): string | null {
  if (!stdout) return null

  const markers = findPublishMarkers(stdout)
  if (markers.length === 0) return stdout

  const opens = markers.filter((m) => m.kind === 'open')
  if (opens.length === 0) return stdout

  for (let i = opens.length - 1; i >= 0; i--) {
    const open = opens[i]
    const next = markers.find((m) => m.index >= open.end)
    const raw = next ? stdout.slice(open.end, next.index) : stdout.slice(open.end)
    const content = raw.trim()
    if (content) return content
  }

  return null
}

/**
 * Content to publish for a completed run, from its output messages (in order).
 * A publish block wins; without one, only the final message is posted, with a
 * note that the agent didn't write a summary. Exported for unit tests.
 */
export function selectPublishContent(messages: string[], agentName: string): string | null {
  const nonEmpty = messages.map((m) => m.trim()).filter(Boolean)
  if (nonEmpty.length === 0) return null

  const full = nonEmpty.join('\n')
  if (findPublishMarkers(full).some((m) => m.kind === 'open')) {
    return resolveRunPublishMessage(full)
  }

  return `_${agentName} finished without a publish summary. Its last message:_\n\n${nonEmpty[nonEmpty.length - 1]}`
}

/** Exported for unit tests. */
export function buildFailureNotice(
  agentName: string,
  run: Pick<ExecutionRun, 'id' | 'agentId' | 'lastLine'>,
  baseUrl: string
): string {
  const reason = run.lastLine?.trim() || 'No failure reason was recorded.'
  const url = `${baseUrl.replace(/\/+$/, '')}/agents/${run.agentId}/runs/${run.id}`
  // Canonical markdown (not Slack-native `<url|text>` syntax) — postToSlack /
  // sendEmail each convert this the same way they convert agent-authored
  // publish blocks, so this notice renders correctly on every target type.
  return `:warning: **${agentName}** run failed.\n\n${reason}\n\n[View run](${url})`
}

// ── Slack ────────────────────────────────────────────────────────────────────

/** Slack rejects a section block whose text exceeds this many characters. */
export const SLACK_SECTION_MAX_CHARS = 3000
/** Slack rejects a message with more blocks than this. */
const SLACK_MAX_BLOCKS = 50

/**
 * Split text into Slack section-sized chunks: pack paragraphs, fall back to
 * line boundaries for an oversized paragraph, and hard-split a single line
 * that is itself too long. Exported for unit tests.
 */
export function splitSlackSections(text: string, max = SLACK_SECTION_MAX_CHARS): string[] {
  const chunks: string[] = []
  let current = ''
  const push = (piece: string, sep: string) => {
    if (current && current.length + sep.length + piece.length <= max) {
      current += sep + piece
      return
    }
    if (current) chunks.push(current)
    current = piece
  }

  for (const paragraph of text.split(/\n\n+/)) {
    if (paragraph.length <= max) {
      push(paragraph, '\n\n')
      continue
    }
    for (const line of paragraph.split('\n')) {
      if (line.length <= max) {
        push(line, '\n')
        continue
      }
      for (let i = 0; i < line.length; i += max) push(line.slice(i, i + max), '')
    }
  }
  if (current) chunks.push(current)
  return chunks
}

/**
 * Slack's mrkdwn parser treats a bare `&`, `<`, or `>` as the start of its
 * own syntax (links, `<@user>` / `<#channel>` mentions) — an unescaped
 * literal like a backtick-quoted `<set>` or `a & b` in agent-authored text
 * isn't a valid reference, so Slack's renderer garbles it into the visible
 * literal text "&lt;set&gt;" instead of showing a plain `<set>`. Escaping
 * first (so our own generated `<url|text>` / `*bold*` syntax isn't
 * re-escaped) tells Slack these are literal characters, not its metachars.
 */
function escapeSlackEntities(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Slack rewrites every bare `https://…` into `<https://…>`, including inside
 * inline code. A code span then shows those angle brackets as literal text
 * (the dependency-upgrade run's `` `Bad credentials (https://api.github.com/graphql)` ``).
 * Lift the URL out of the span so it becomes a real link and the surrounding
 * code stays code. Trailing sentence punctuation is left outside the link.
 */
function splitUrlsOutOfInlineCode(inner: string): string {
  const re = /https?:\/\/[^\s`<>]+/gi
  let out = ''
  let last = 0
  let found = false
  let match: RegExpExecArray | null
  while ((match = re.exec(inner)) !== null) {
    found = true
    let url = match[0]
    let end = match.index + url.length
    while (url.length > 0 && /[.,;:!?)]$/.test(url)) {
      const ch = url[url.length - 1]
      if (ch === ')' && url.includes('(')) break
      url = url.slice(0, -1)
      end -= 1
    }
    const before = inner.slice(last, match.index)
    if (before) out += `\`${before}\``
    if (url) out += `<${url}>`
    last = end
  }
  if (!found) return `\`${inner}\``
  const after = inner.slice(last)
  if (after) out += `\`${after}\``
  return out
}

/** Code is stashed so list/bold conversion can't rewrite samples. */
function stashSlackCode(text: string): { text: string; slots: string[] } {
  const slots: string[] = []
  const put = (raw: string) => {
    const token = `\uE000${slots.length}\uE001`
    if (raw.startsWith('```')) {
      // A fenced sample should stay one block. Break the scheme so Slack's
      // autolinker doesn't wrap the URL in angle brackets inside the fence.
      slots.push(
        escapeSlackEntities(raw).replace(/https?:\/\//gi, (scheme) => scheme.replace('://', ':\u200b//'))
      )
    } else {
      slots.push(splitUrlsOutOfInlineCode(escapeSlackEntities(raw.slice(1, -1))))
    }
    return token
  }
  let out = text.replace(/```[\s\S]*?```/g, put)
  out = out.replace(/`[^`\n]+`/g, put)
  return { text: out, slots }
}

function restoreSlackCode(text: string, slots: string[]): string {
  return text.replace(/\uE000(\d+)\uE001/g, (_m, n: string) => slots[Number(n)] ?? '')
}

/**
 * Slack has no heading syntax. A line like `## Front-End Performance Loop`
 * is posted with the hashes visible. Turn ATX headings into a bold line.
 * Bold markers already converted from `**` are stripped so the title is
 * wrapped once.
 */
function normalizeSlackHeadings(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const m = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/)
      if (!m) return line
      const title = m[1].replace(/\*/g, '').replace(/\s+/g, ' ').trim()
      return title ? `*${title}*` : line
    })
    .join('\n')
}

/**
 * Slack has no nested-list syntax. A mix of `-`, `*`, and `1.` at shifting
 * indents renders as a ragged wall. Collapse that to a `•` (numbers kept)
 * at a stable indent.
 */
function normalizeSlackLists(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const m = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/)
      if (!m) return line
      const spaces = m[1].replace(/\t/g, '  ').length
      const depth = spaces === 0 ? 0 : spaces <= 2 ? 1 : 2
      const indent = '    '.repeat(depth)
      const marker = /^\d+\.$/.test(m[2]) ? m[2] : '•'
      return `${indent}${marker} ${m[3]}`
    })
    .join('\n')
}

/** Exported for unit tests. */
export function markdownToSlackMrkdwn(text: string): string {
  const { text: stashed, slots } = stashSlackCode(text)
  let result = escapeSlackEntities(stashed)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')
  result = result.replace(/\*\*([^*]+)\*\*/g, '*$1*')
  result = normalizeSlackHeadings(result)
  result = normalizeSlackLists(result)
  return restoreSlackCode(result, slots)
}

interface SlackBlock {
  type: string
  text?: { type: string; text: string }
}

async function postToSlack(config: SlackPublishConfig, message: string): Promise<void> {
  const slackMessage = markdownToSlackMrkdwn(message)

  const sections = splitSlackSections(slackMessage)
  const kept = sections.length > SLACK_MAX_BLOCKS ? sections.slice(0, SLACK_MAX_BLOCKS - 1) : sections
  const blocks: SlackBlock[] = kept.map((chunk) => ({ type: 'section', text: { type: 'mrkdwn', text: chunk } }))
  if (kept.length < sections.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_…(truncated)_' } })
  }

  const body: Record<string, unknown> = {
    text: slackMessage,
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  }
  if (config.iconEmoji) body.icon_emoji = config.iconEmoji

  if (config.webhookUrl) {
    const res = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Slack webhook failed: ${res.status} ${text}`)
    }
  } else if (config.botToken) {
    body.channel = config.channel
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${config.botToken}`,
      },
      body: JSON.stringify(body),
    })
    const data = await res.json() as { ok: boolean; error?: string }
    if (!data.ok) throw new Error(`Slack API error: ${data.error}`)
  } else {
    throw new Error('Slack config requires either webhookUrl or botToken')
  }
}

// ── Email ────────────────────────────────────────────────────────────────────

async function sendEmail(config: EmailPublishConfig, message: string): Promise<void> {
  // Use nodemailer dynamically (it's a peer dep)
  const nodemailer = await import('nodemailer')

  const transport = nodemailer.default.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass,
    },
  })

  await transport.sendMail({
    from: config.from,
    to: config.to,
    subject: config.subject,
    text: message,
    html: markdownToHtml(message),
  })
}

/** Simple markdown → HTML for email bodies. */
function markdownToHtml(text: string): string {
  let html = text
    // Escape HTML entities first
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // Code blocks
  html = html.replace(/```([\s\S]*?)```/g, '<pre style="background:#f4f4f4;padding:12px;border-radius:6px;overflow-x:auto;font-size:13px"><code>$1</code></pre>')
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code style="background:#f4f4f4;padding:2px 4px;border-radius:3px;font-size:13px">$1</code>')
  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  // Links — [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#4A90D9">$1</a>')
  // Line breaks
  html = html.replace(/\n/g, '<br>')

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.6;color:#333">${html}</div>`
}

// ── Webhook ──────────────────────────────────────────────────────────────────

async function postToWebhook(config: WebhookPublishConfig, message: string, agentName?: string, runId?: string): Promise<void> {
  const payload = {
    content: message,
    agent: agentName,
    runId,
    timestamp: new Date().toISOString(),
  }

  const bodyStr = JSON.stringify(payload)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...config.headers,
  }

  // HMAC signature if a secret is configured
  if (config.secret) {
    const signature = crypto
      .createHmac('sha256', config.secret)
      .update(bodyStr)
      .digest('hex')
    headers['X-Conduit-Signature'] = `sha256=${signature}`
  }

  const res = await fetch(config.url, {
    method: config.method ?? 'POST',
    headers,
    body: bodyStr,
    signal: AbortSignal.timeout(15000),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Webhook failed: ${res.status} ${text.slice(0, 200)}`)
  }
}

// ── Test ─────────────────────────────────────────────────────────────────────

export async function testPublishTarget(
  type: PublishTargetType,
  config: PublishConfig
): Promise<{ success: boolean; error?: string }> {
  const testMessage = 'Conduit test message — this publish target is configured correctly.'
  try {
    switch (type) {
      case 'slack':
        await postToSlack(config as SlackPublishConfig, `:test_tube: ${testMessage}`)
        break
      case 'email':
        await sendEmail(
          { ...(config as EmailPublishConfig), subject: 'Conduit Test' },
          testMessage
        )
        break
      case 'webhook':
        await postToWebhook(config as WebhookPublishConfig, testMessage, 'Test Agent', 'test-run')
        break
    }
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ── Health / connection validation ─────────────────────────────────────────────

// Slack API errors that specifically indicate an auth/token problem (vs. a
// transient or configuration error) — surfaced as 'unauthorized' so the UI can
// flag that the bot token needs attention.
const SLACK_AUTH_ERRORS = new Set([
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'token_expired',
  'account_inactive',
  'no_permission',
  'missing_scope',
])

/**
 * Validate a Slack publish target's connection without sending a message.
 * Bot-token configs are checked via Slack's `auth.test`; webhook-only configs
 * can't be verified without posting, so a well-formed hook URL is reported as
 * configured.
 */
export async function checkSlackHealth(config: SlackPublishConfig): Promise<PublishTargetHealthResult> {
  if (config.botToken) {
    try {
      const res = await fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.botToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        signal: AbortSignal.timeout(5000),
      })
      const data = (await res.json()) as { ok: boolean; error?: string; user?: string; team?: string }
      if (data.ok) {
        const who = [data.user, data.team].filter(Boolean).join(' · ')
        return { status: 'healthy', message: who ? `Connected as ${who}` : 'Connected' }
      }
      if (data.error && SLACK_AUTH_ERRORS.has(data.error)) {
        return { status: 'unauthorized', message: `Auth failed: ${data.error}` }
      }
      return { status: 'unhealthy', message: `Slack error: ${data.error ?? 'unknown'}` }
    } catch (err) {
      return { status: 'unhealthy', message: err instanceof Error ? err.message : 'Connection failed' }
    }
  }
  if (config.webhookUrl) {
    return /^https:\/\/hooks\.slack\.com\//.test(config.webhookUrl)
      ? { status: 'healthy', message: 'Webhook configured (not verifiable without sending)' }
      : { status: 'unhealthy', message: 'Does not look like a Slack incoming webhook URL' }
  }
  return { status: 'unhealthy', message: 'No bot token or webhook URL configured' }
}

/**
 * Validate a publish target's connection. Slack is checked live; other types
 * have no lightweight connection check, so they report as configured.
 */
export async function checkPublishTargetHealth(
  type: PublishTargetType,
  config: PublishConfig
): Promise<PublishTargetHealthResult> {
  if (type === 'slack') return checkSlackHealth(config as SlackPublishConfig)
  return { status: 'healthy', message: 'Configured' }
}

// ── Publish run result ───────────────────────────────────────────────────────

export type PublishOutcome =
  | { targetName: string; ok: true }
  | { targetName: string; ok: false; error: string }

/** Per-target delivery outcomes, so the caller can record them on the run. */
export async function publishRunResult(
  agentId: string,
  run: ExecutionRun
): Promise<PublishOutcome[]> {
  if (run.status !== 'completed' && run.status !== 'failed') return []

  const agent = await getAgent(agentId)
  if (!agent?.publishTargetIds?.length) return []

  let publishContent: string | null
  if (run.status === 'failed') {
    const baseUrl = process.env.CONDUIT_BASE_URL ?? `http://localhost:${process.env.PORT ?? 7456}`
    publishContent = buildFailureNotice(agent.name, run, baseUrl)
  } else {
    let messages: string[]
    try {
      messages = readRunOutputMessages(run.id)
    } catch {
      return []
    }
    publishContent = selectPublishContent(messages, agent.name)
  }
  if (!publishContent) return []

  const message = publishContent.length > 39000
    ? publishContent.slice(0, 39000) + '\n…(truncated)'
    : publishContent

  const outcomes: PublishOutcome[] = []
  for (const targetId of agent.publishTargetIds) {
    const target = await getPublishTarget(targetId)
    if (!target || !target.enabled) continue

    try {
      switch (target.type) {
        case 'slack':
          await postToSlack(target.config as SlackPublishConfig, message)
          break
        case 'email': {
          const emailConfig = target.config as EmailPublishConfig
          const subject = emailConfig.subject
            .replace('{{agentName}}', agent.name)
            .replace('{{status}}', run.status)
          await sendEmail({ ...emailConfig, subject }, message)
          break
        }
        case 'webhook':
          await postToWebhook(target.config as WebhookPublishConfig, message, agent.name, run.id)
          break
      }
      outcomes.push({ targetName: target.name, ok: true })
    } catch (err) {
      console.error(`[publisher] Failed to publish to target ${target.name}:`, err)
      outcomes.push({ targetName: target.name, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return outcomes
}
