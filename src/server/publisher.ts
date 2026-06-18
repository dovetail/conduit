import * as crypto from 'crypto'
import type { ExecutionRun, SlackPublishConfig, EmailPublishConfig, WebhookPublishConfig, PublishTargetType, PublishConfig } from '../shared/types'
import { getPublishTarget } from '../main/db/queries/publishTargets'
import { getAgent } from '../main/db/queries/agents'
import { readLogFile } from './utils'

/**
 * Publish target is a dumb delivery channel — the agent controls the content.
 *
 * Convention: if the agent's stdout contains a block delimited by
 *   <!--CONDUIT:PUBLISH-->
 *   ...content...
 *   <!--/CONDUIT:PUBLISH-->
 * then only that content is posted. Otherwise the full stdout output is sent.
 */

const PUBLISH_START = '<!--CONDUIT:PUBLISH-->'
const PUBLISH_END = '<!--/CONDUIT:PUBLISH-->'

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

function extractPublishContent(stdout: string): string | null {
  const startIdx = stdout.indexOf(PUBLISH_START)
  if (startIdx === -1) return null
  const contentStart = startIdx + PUBLISH_START.length
  const endIdx = stdout.indexOf(PUBLISH_END, contentStart)
  if (endIdx === -1) return null
  return stdout.slice(contentStart, endIdx).trim()
}

// ── Slack ────────────────────────────────────────────────────────────────────

function markdownToSlackMrkdwn(text: string): string {
  let result = text
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')
  result = result.replace(/\*\*([^*]+)\*\*/g, '*$1*')
  return result
}

interface SlackBlock {
  type: string
  text?: { type: string; text: string }
}

async function postToSlack(config: SlackPublishConfig, message: string): Promise<void> {
  const slackMessage = markdownToSlackMrkdwn(message)

  const blocks: SlackBlock[] = []
  const chunks: string[] = []
  if (slackMessage.length <= 3000) {
    chunks.push(slackMessage)
  } else {
    const paragraphs = slackMessage.split(/\n\n+/)
    let current = ''
    for (const p of paragraphs) {
      if (current.length + p.length + 2 > 3000) {
        if (current) chunks.push(current.trim())
        current = p
      } else {
        current += (current ? '\n\n' : '') + p
      }
    }
    if (current) chunks.push(current.trim())
  }

  for (const chunk of chunks) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } })
  }

  const body: Record<string, unknown> = {
    text: message,
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

// ── Publish run result ───────────────────────────────────────────────────────

export async function publishRunResult(
  agentId: string,
  run: ExecutionRun
): Promise<void> {
  if (run.status !== 'completed') return

  const agent = await getAgent(agentId)
  if (!agent?.publishTargetIds?.length) return

  let fullStdout = ''
  try {
    const entries = readLogFile(run.id)
    fullStdout = entries
      .filter((e) => e.stream === 'stdout')
      .map((e) => stripAnsi(e.chunk).trim())
      .filter(Boolean)
      .join('\n')
  } catch {
    return
  }

  if (!fullStdout) return

  const publishContent = extractPublishContent(fullStdout) ?? fullStdout
  const message = publishContent.length > 39000
    ? publishContent.slice(0, 39000) + '\n…(truncated)'
    : publishContent

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
    } catch (err) {
      console.error(`[publisher] Failed to publish to target ${target.name}:`, err)
    }
  }
}
