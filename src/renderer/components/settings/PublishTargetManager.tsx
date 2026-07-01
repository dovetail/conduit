import React, { useState } from 'react'
import { Plus, Pencil, Trash2, Info, Loader2, X, Check, Send, Mail, Globe, Share2, RefreshCw } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { ShareDialog } from '@renderer/components/ShareDialog'
import {
  usePublishTargets,
  useCreatePublishTarget,
  useUpdatePublishTarget,
  useDeletePublishTarget,
  useTestPublishTarget,
  usePublishTargetHealth,
} from '@renderer/hooks/usePublishTargets'
import { useAuth } from '@renderer/contexts/AuthContext'
import { cn } from '@renderer/lib/utils'
import type {
  PublishTarget,
  PublishTargetType,
  PublishConfig,
  SlackPublishConfig,
  EmailPublishConfig,
  WebhookPublishConfig,
} from '@shared/types'

// ── Slack icon SVG ───────────────────────────────────────────────────────────

function SlackIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" fill="currentColor"/>
    </svg>
  )
}

// ── Type icon/badge helpers ──────────────────────────────────────────────────

function TypeIcon({ type }: { type: PublishTargetType }) {
  switch (type) {
    case 'slack':
      return <div className="flex-shrink-0 w-6 h-6 rounded bg-[#4A154B] flex items-center justify-center text-white"><SlackIcon /></div>
    case 'email':
      return <div className="flex-shrink-0 w-6 h-6 rounded bg-blue-600 flex items-center justify-center text-white"><Mail className="h-3.5 w-3.5" /></div>
    case 'webhook':
      return <div className="flex-shrink-0 w-6 h-6 rounded bg-emerald-600 flex items-center justify-center text-white"><Globe className="h-3.5 w-3.5" /></div>
  }
}

function targetSubtitle(target: PublishTarget): string {
  switch (target.type) {
    case 'slack': {
      const c = target.config as SlackPublishConfig
      return c.webhookUrl ? 'Webhook' : `Bot → #${c.channel}`
    }
    case 'email': {
      const c = target.config as EmailPublishConfig
      return `${c.from} → ${c.to}`
    }
    case 'webhook': {
      const c = target.config as WebhookPublishConfig
      return `${c.method ?? 'POST'} ${c.url}`
    }
  }
}

// ── Form state ───────────────────────────────────────────────────────────────

interface FormState {
  name: string
  type: PublishTargetType
  enabled: boolean
  // Slack
  slackBotToken: string
  slackWebhookUrl: string
  slackChannel: string
  slackIconEmoji: string
  // Email
  emailSmtpHost: string
  emailSmtpPort: string
  emailSmtpUser: string
  emailSmtpPass: string
  emailSmtpSecure: boolean
  emailFrom: string
  emailTo: string
  emailSubject: string
  // Webhook
  webhookUrl: string
  webhookMethod: 'POST' | 'PUT'
  webhookHeaders: string // JSON string
  webhookSecret: string
}

function emptyForm(): FormState {
  return {
    name: '',
    type: 'slack',
    enabled: true,
    slackBotToken: '',
    slackWebhookUrl: '',
    slackChannel: '',
    slackIconEmoji: ':robot_face:',
    emailSmtpHost: '',
    emailSmtpPort: '587',
    emailSmtpUser: '',
    emailSmtpPass: '',
    emailSmtpSecure: true,
    emailFrom: '',
    emailTo: '',
    emailSubject: '[Conduit] {{agentName}} run {{status}}',
    webhookUrl: '',
    webhookMethod: 'POST',
    webhookHeaders: '{}',
    webhookSecret: '',
  }
}

function formFromTarget(target: PublishTarget): FormState {
  const base = emptyForm()
  base.name = target.name
  base.type = target.type
  base.enabled = target.enabled

  switch (target.type) {
    case 'slack': {
      const c = target.config as SlackPublishConfig
      base.slackBotToken = c.botToken ?? ''
      base.slackWebhookUrl = c.webhookUrl ?? ''
      base.slackChannel = c.channel
      base.slackIconEmoji = c.iconEmoji ?? ':robot_face:'
      break
    }
    case 'email': {
      const c = target.config as EmailPublishConfig
      base.emailSmtpHost = c.smtpHost
      base.emailSmtpPort = String(c.smtpPort)
      base.emailSmtpUser = c.smtpUser
      base.emailSmtpPass = c.smtpPass
      base.emailSmtpSecure = c.smtpSecure
      base.emailFrom = c.from
      base.emailTo = c.to
      base.emailSubject = c.subject
      break
    }
    case 'webhook': {
      const c = target.config as WebhookPublishConfig
      base.webhookUrl = c.url
      base.webhookMethod = c.method ?? 'POST'
      base.webhookHeaders = JSON.stringify(c.headers ?? {}, null, 2)
      base.webhookSecret = c.secret ?? ''
      break
    }
  }
  return base
}

function formToConfig(form: FormState): PublishConfig {
  switch (form.type) {
    case 'slack':
      return {
        botToken: form.slackBotToken.trim() || undefined,
        webhookUrl: form.slackWebhookUrl.trim() || undefined,
        channel: form.slackChannel.trim(),
        iconEmoji: form.slackIconEmoji.trim() || undefined,
      } as SlackPublishConfig
    case 'email':
      return {
        smtpHost: form.emailSmtpHost.trim(),
        smtpPort: parseInt(form.emailSmtpPort) || 587,
        smtpUser: form.emailSmtpUser.trim(),
        smtpPass: form.emailSmtpPass,
        smtpSecure: form.emailSmtpSecure,
        from: form.emailFrom.trim(),
        to: form.emailTo.trim(),
        subject: form.emailSubject.trim(),
      } as EmailPublishConfig
    case 'webhook': {
      let headers: Record<string, string> = {}
      try { headers = JSON.parse(form.webhookHeaders) } catch { /* empty */ }
      return {
        url: form.webhookUrl.trim(),
        method: form.webhookMethod,
        headers,
        secret: form.webhookSecret.trim() || undefined,
      } as WebhookPublishConfig
    }
  }
}

function isFormValid(form: FormState): boolean {
  if (!form.name.trim()) return false
  switch (form.type) {
    case 'slack':
      return !!(form.slackBotToken.trim() || form.slackWebhookUrl.trim()) &&
        (form.slackBotToken.trim() ? !!form.slackChannel.trim() : true)
    case 'email':
      return !!(form.emailSmtpHost.trim() && form.emailFrom.trim() && form.emailTo.trim())
    case 'webhook':
      return !!form.webhookUrl.trim()
  }
}

function canTestForm(form: FormState): boolean {
  switch (form.type) {
    case 'slack':
      return !!(form.slackBotToken.trim() || form.slackWebhookUrl.trim()) &&
        (form.slackBotToken.trim() ? !!form.slackChannel.trim() : true)
    case 'email':
      return !!(form.emailSmtpHost.trim() && form.emailFrom.trim() && form.emailTo.trim())
    case 'webhook':
      return !!form.webhookUrl.trim()
  }
}

// ── Type-specific form sections ──────────────────────────────────────────────

function SlackFields({ form, setForm }: { form: FormState; setForm: React.Dispatch<React.SetStateAction<FormState>> }) {
  const mode = form.slackWebhookUrl.trim() ? 'webhook' : 'bot'
  return (
    <>
      <div className="flex gap-1 p-0.5 rounded-md bg-[var(--bg-primary)] border border-[var(--border)]">
        <button type="button" onClick={() => setForm(f => ({ ...f, slackWebhookUrl: '' }))}
          className={cn('flex-1 text-xs py-1.5 rounded-md transition-colors font-medium', mode === 'bot' ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}>
          Bot Token
        </button>
        <button type="button" onClick={() => setForm(f => ({ ...f, slackBotToken: '' }))}
          className={cn('flex-1 text-xs py-1.5 rounded-md transition-colors font-medium', mode === 'webhook' ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}>
          Webhook URL
        </button>
      </div>
      {mode === 'bot' ? (
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="block text-xs text-[var(--text-secondary)]">Bot User OAuth Token</label>
            <Input value={form.slackBotToken} onChange={e => setForm(f => ({ ...f, slackBotToken: e.target.value }))} placeholder="xoxb-..." className="font-mono text-xs" type="password" />
          </div>
          <div className="space-y-1">
            <label className="block text-xs text-[var(--text-secondary)]">Channel ID</label>
            <Input value={form.slackChannel} onChange={e => setForm(f => ({ ...f, slackChannel: e.target.value }))} placeholder="C0123456789" className="font-mono text-xs" />
            <p className="text-[10px] text-[var(--text-secondary)] opacity-70">Right-click a channel in Slack → View channel details → copy the ID.</p>
          </div>
        </div>
      ) : (
        <div className="space-y-1">
          <label className="block text-xs text-[var(--text-secondary)]">Incoming Webhook URL</label>
          <Input value={form.slackWebhookUrl} onChange={e => setForm(f => ({ ...f, slackWebhookUrl: e.target.value }))} placeholder="https://hooks.slack.com/services/T.../B.../..." className="font-mono text-xs" type="password" />
        </div>
      )}
      <div className="space-y-1">
        <label className="block text-xs text-[var(--text-secondary)]">Icon Emoji <span className="opacity-60">(optional)</span></label>
        <Input value={form.slackIconEmoji} onChange={e => setForm(f => ({ ...f, slackIconEmoji: e.target.value }))} placeholder=":robot_face:" className="text-xs w-48" />
      </div>
    </>
  )
}

function EmailFields({ form, setForm }: { form: FormState; setForm: React.Dispatch<React.SetStateAction<FormState>> }) {
  return (
    <>
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2 space-y-1">
          <label className="block text-xs text-[var(--text-secondary)]">SMTP Host</label>
          <Input value={form.emailSmtpHost} onChange={e => setForm(f => ({ ...f, emailSmtpHost: e.target.value }))} placeholder="smtp.gmail.com" className="font-mono text-xs" />
        </div>
        <div className="space-y-1">
          <label className="block text-xs text-[var(--text-secondary)]">Port</label>
          <Input value={form.emailSmtpPort} onChange={e => setForm(f => ({ ...f, emailSmtpPort: e.target.value }))} placeholder="587" className="font-mono text-xs" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="block text-xs text-[var(--text-secondary)]">Username</label>
          <Input value={form.emailSmtpUser} onChange={e => setForm(f => ({ ...f, emailSmtpUser: e.target.value }))} placeholder="you@gmail.com" className="text-xs" />
        </div>
        <div className="space-y-1">
          <label className="block text-xs text-[var(--text-secondary)]">Password</label>
          <Input value={form.emailSmtpPass} onChange={e => setForm(f => ({ ...f, emailSmtpPass: e.target.value }))} placeholder="app password" className="text-xs" type="password" />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input type="checkbox" id="smtp-secure" checked={form.emailSmtpSecure} onChange={e => setForm(f => ({ ...f, emailSmtpSecure: e.target.checked }))} className="accent-[var(--accent)]" />
        <label htmlFor="smtp-secure" className="text-xs text-[var(--text-secondary)] cursor-pointer">Use TLS</label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="block text-xs text-[var(--text-secondary)]">From</label>
          <Input value={form.emailFrom} onChange={e => setForm(f => ({ ...f, emailFrom: e.target.value }))} placeholder="conduit@yourco.com" className="text-xs" />
        </div>
        <div className="space-y-1">
          <label className="block text-xs text-[var(--text-secondary)]">To <span className="opacity-60">(comma-separated)</span></label>
          <Input value={form.emailTo} onChange={e => setForm(f => ({ ...f, emailTo: e.target.value }))} placeholder="team@yourco.com, you@yourco.com" className="text-xs" />
        </div>
      </div>
      <div className="space-y-1">
        <label className="block text-xs text-[var(--text-secondary)]">Subject template</label>
        <Input value={form.emailSubject} onChange={e => setForm(f => ({ ...f, emailSubject: e.target.value }))} placeholder="[Conduit] {{agentName}} run {{status}}" className="text-xs" />
        <p className="text-[10px] text-[var(--text-secondary)] opacity-70">{'{{agentName}} and {{status}} are replaced at send time.'}</p>
      </div>
    </>
  )
}

function WebhookFields({ form, setForm }: { form: FormState; setForm: React.Dispatch<React.SetStateAction<FormState>> }) {
  return (
    <>
      <div className="space-y-1">
        <label className="block text-xs text-[var(--text-secondary)]">URL</label>
        <Input value={form.webhookUrl} onChange={e => setForm(f => ({ ...f, webhookUrl: e.target.value }))} placeholder="https://api.yourco.com/hooks/conduit" className="font-mono text-xs" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="block text-xs text-[var(--text-secondary)]">Method</label>
          <select
            value={form.webhookMethod}
            onChange={e => setForm(f => ({ ...f, webhookMethod: e.target.value as 'POST' | 'PUT' }))}
            className="w-full h-8 px-2 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] text-xs"
          >
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
          </select>
        </div>
        <div className="space-y-1">
          <label className="block text-xs text-[var(--text-secondary)]">Signing Secret <span className="opacity-60">(optional)</span></label>
          <Input value={form.webhookSecret} onChange={e => setForm(f => ({ ...f, webhookSecret: e.target.value }))} placeholder="whsec_..." className="font-mono text-xs" type="password" />
        </div>
      </div>
      <div className="space-y-1">
        <label className="block text-xs text-[var(--text-secondary)]">Headers <span className="opacity-60">(JSON)</span></label>
        <textarea
          value={form.webhookHeaders}
          onChange={e => setForm(f => ({ ...f, webhookHeaders: e.target.value }))}
          placeholder='{"Authorization": "Bearer ..."}'
          rows={3}
          className="w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] font-mono text-xs resize-none focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
        />
      </div>
      <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-[var(--bg-primary)] border border-[var(--border)] text-[10px] text-[var(--text-secondary)]">
        <Info className="h-3 w-3 flex-shrink-0 mt-0.5 text-[var(--accent)]" />
        <span>Payload: <code className="text-[var(--text-primary)]">{'{ content, agent, runId, timestamp }'}</code>. If a signing secret is set, an <code className="text-[var(--text-primary)]">X-Conduit-Signature</code> HMAC-SHA256 header is included.</span>
      </div>
    </>
  )
}

// ── Inline form ──────────────────────────────────────────────────────────────

interface InlineFormProps {
  initial: FormState
  onSave: (form: FormState) => void
  onCancel: () => void
  saving: boolean
  /** Existing target id — enables the live connection-status indicator in the detail view. */
  targetId?: string
}

function InlineForm({ initial, onSave, onCancel, saving, targetId }: InlineFormProps) {
  const [form, setForm] = useState<FormState>(initial)
  const testMutation = useTestPublishTarget()

  const handleTest = () => {
    testMutation.reset()
    testMutation.mutate({ type: form.type, config: formToConfig(form) })
  }

  const testError = testMutation.error
    ? testMutation.error instanceof Error ? testMutation.error.message : String(testMutation.error)
    : testMutation.data && !testMutation.data.success
    ? testMutation.data.error
    : null

  return (
    <div className="border border-[var(--border)] rounded-lg bg-[var(--bg-secondary)] p-4 space-y-4">
      {/* Name */}
      <div className="space-y-1">
        <label className="block text-xs font-medium text-[var(--text-secondary)]">Target Name</label>
        <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. #eng-alerts, team-email, ci-webhook" autoFocus />
      </div>

      {/* Type selector */}
      <div className="space-y-2">
        <label className="block text-xs font-medium text-[var(--text-secondary)]">Type</label>
        <div className="flex gap-1 p-0.5 rounded-md bg-[var(--bg-primary)] border border-[var(--border)]">
          {(['slack', 'email', 'webhook'] as PublishTargetType[]).map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setForm(f => ({ ...f, type: t }))}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 text-xs py-1.5 rounded-md transition-colors font-medium capitalize',
                form.type === t
                  ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              )}
            >
              {t === 'slack' && <SlackIcon size={12} />}
              {t === 'email' && <Mail className="h-3 w-3" />}
              {t === 'webhook' && <Globe className="h-3 w-3" />}
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Type-specific fields */}
      {form.type === 'slack' && <SlackFields form={form} setForm={setForm} />}
      {form.type === 'email' && <EmailFields form={form} setForm={setForm} />}
      {form.type === 'webhook' && <WebhookFields form={form} setForm={setForm} />}

      {/* Enabled */}
      <div className="flex items-center gap-2">
        <input type="checkbox" id="pt-form-enabled" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} className="rounded border-[var(--border)] accent-[var(--accent)]" />
        <label htmlFor="pt-form-enabled" className="text-xs text-[var(--text-secondary)] cursor-pointer">Enabled</label>
      </div>

      {/* Connection status (Slack, existing target) */}
      {form.type === 'slack' && targetId && (
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-[var(--text-secondary)]">Connection:</span>
          <PublishTargetHealthDot id={targetId} type={form.type} config={formToConfig(form)} showLabel />
        </div>
      )}

      {/* Test result */}
      {testMutation.data?.success && (
        <div className="text-xs px-3 py-2 rounded-md bg-green-500/10 text-green-400 border border-green-500/20">
          Test {form.type === 'email' ? 'email' : 'message'} sent successfully!
        </div>
      )}
      {testError && (
        <div className="text-xs px-3 py-2 rounded-md bg-red-500/10 text-red-400 border border-red-500/20">
          Test failed: {testError}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between pt-1">
        <Button variant="outline" size="sm" onClick={handleTest} disabled={!canTestForm(form) || testMutation.isPending} className="gap-1.5 text-xs">
          {testMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
          Send Test
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button size="sm" onClick={() => onSave(form)} disabled={!isFormValid(form) || saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Target row ───────────────────────────────────────────────────────────────

/**
 * Connection-status indicator for a publish target, mirroring the MCP health dot.
 * Only Slack targets are validated; for other types it renders nothing.
 * `showLabel` renders the status text inline (detail view); otherwise just the
 * dot with a hover refresh affordance (list view). Click to re-check.
 */
function PublishTargetHealthDot({
  id,
  type,
  config,
  showLabel = false,
}: {
  id: string
  type: PublishTargetType
  config: PublishConfig
  showLabel?: boolean
}) {
  const { data, isLoading, isFetching, refetch } = usePublishTargetHealth(id, type, config, type === 'slack')
  if (type !== 'slack') return null

  const pending = isLoading || isFetching
  const color = pending
    ? '#F59E0B'
    : data?.status === 'healthy'
    ? '#22C55E'
    : data?.status === 'unauthorized'
    ? '#F59E0B'
    : '#EF4444'
  const label = pending
    ? 'Checking…'
    : data?.status === 'healthy'
    ? `Connected · ${data.message}`
    : data?.status === 'unauthorized'
    ? `Authentication required · ${data.message}`
    : `Not connected · ${data?.message ?? 'Unknown error'}`

  return (
    <button
      onClick={(e) => { e.stopPropagation(); void refetch() }}
      title={label}
      className="flex items-center gap-1.5 flex-shrink-0 group min-w-0"
      aria-label={label}
    >
      <span
        className={cn('inline-block w-2 h-2 rounded-full transition-colors flex-shrink-0', pending && 'animate-pulse')}
        style={{ backgroundColor: color }}
      />
      {showLabel ? (
        <span className="text-xs text-[var(--text-secondary)] truncate">{label}</span>
      ) : (
        <RefreshCw className="h-2.5 w-2.5 text-[var(--text-secondary)] opacity-0 group-hover:opacity-60 transition-opacity" />
      )}
    </button>
  )
}

function TargetRow({ target, isOwner, onShare }: { target: PublishTarget; isOwner: boolean; onShare: () => void }) {
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const updateTarget = useUpdatePublishTarget()
  const deleteTarget = useDeletePublishTarget()

  const handleToggle = () => updateTarget.mutate({ id: target.id, data: { enabled: !target.enabled } })

  const handleSave = (form: FormState) => {
    updateTarget.mutate(
      { id: target.id, data: { name: form.name.trim(), type: form.type, config: formToConfig(form), enabled: form.enabled } },
      { onSuccess: () => setEditing(false) }
    )
  }

  const handleDelete = () => {
    if (!confirmDelete) { setConfirmDelete(true); return }
    deleteTarget.mutate(target.id)
  }

  if (editing) {
    return <InlineForm initial={formFromTarget(target)} onSave={handleSave} onCancel={() => setEditing(false)} saving={updateTarget.isPending} targetId={target.id} />
  }

  return (
    <div className={cn('flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors', target.enabled ? 'border-[var(--border)] bg-[var(--bg-secondary)]' : 'border-[var(--border)] bg-[var(--bg-primary)] opacity-60')}>
      <button onClick={handleToggle} disabled={updateTarget.isPending} title={target.enabled ? 'Disable' : 'Enable'}
        className={cn('w-4 h-4 rounded-full border-2 flex-shrink-0 transition-colors', target.enabled ? 'bg-[var(--accent)] border-[var(--accent)]' : 'bg-transparent border-[var(--text-secondary)]')}
        aria-label={target.enabled ? 'Disable target' : 'Enable target'} />
      <TypeIcon type={target.type} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-[var(--text-primary)] truncate">
          {target.name}
          {!target.enabled && <span className="ml-2 text-xs text-[var(--text-secondary)] font-normal">(disabled)</span>}
        </p>
        <p className="text-xs text-[var(--text-secondary)] truncate">{targetSubtitle(target)}</p>
      </div>
      <PublishTargetHealthDot id={target.id} type={target.type} config={target.config} />
      <div className="flex items-center gap-1 flex-shrink-0">
        {isOwner && (
          <button onClick={onShare} className="p-1.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)] transition-colors" title="Share">
            <Share2 className="h-3.5 w-3.5" />
          </button>
        )}
        <button onClick={() => { setEditing(true); setConfirmDelete(false) }} className="p-1.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)] transition-colors" title="Edit">
          <Pencil className="h-3.5 w-3.5" />
        </button>
        {confirmDelete ? (
          <>
            <span className="text-xs text-red-400 ml-1">Delete?</span>
            <button onClick={handleDelete} disabled={deleteTarget.isPending} className="p-1.5 rounded-md text-red-400 hover:bg-red-400/10 transition-colors" title="Confirm delete">
              {deleteTarget.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            </button>
            <button onClick={() => setConfirmDelete(false)} className="p-1.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-primary)] transition-colors" title="Cancel">
              <X className="h-3.5 w-3.5" />
            </button>
          </>
        ) : (
          <button onClick={handleDelete} className="p-1.5 rounded-md text-[var(--text-secondary)] hover:bg-red-400/10 hover:text-red-400 transition-colors" title="Delete">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────────

export function PublishTargetManager() {
  const { data: targets = [], isLoading } = usePublishTargets()
  const { user } = useAuth()
  const createTarget = useCreatePublishTarget()
  const [showAddForm, setShowAddForm] = useState(false)
  const [shareTargetId, setShareTargetId] = useState<string | null>(null)

  const handleCreate = (form: FormState) => {
    createTarget.mutate(
      { name: form.name.trim(), type: form.type, config: formToConfig(form), enabled: form.enabled },
      { onSuccess: () => setShowAddForm(false) }
    )
  }

  const myTargets = targets.filter((t) => t.ownerId === user?.id)
  const sharedTargets = targets.filter((t) => t.ownerId !== user?.id)

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--bg-primary)' }}>
      <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)] flex-shrink-0">
        <div>
          <h1 className="text-sm font-semibold text-[var(--text-primary)]">Publish Targets</h1>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">Delivery channels for agent output</p>
        </div>
        <Button size="sm" onClick={() => setShowAddForm(true)} disabled={showAddForm} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-[var(--accent)]/10 border border-[var(--accent)]/20 text-xs text-[var(--text-secondary)]">
          <Info className="h-3.5 w-3.5 text-[var(--accent)] flex-shrink-0 mt-0.5" />
          <div className="space-y-1">
            <span>Publish targets are delivery channels — the agent controls the message content. Assign targets to agents in the agent editor.</span>
            <p className="opacity-70">Tip: agents can emit a <code className="text-[var(--text-primary)]">&lt;!--CONDUIT:PUBLISH--&gt;</code> block to control what gets posted.</p>
          </div>
        </div>

        {showAddForm && <InlineForm initial={emptyForm()} onSave={handleCreate} onCancel={() => setShowAddForm(false)} saving={createTarget.isPending} />}

        {isLoading ? (
          <div className="flex items-center justify-center py-10 text-sm text-[var(--text-secondary)]"><Loader2 className="h-4 w-4 animate-spin mr-2" />Loading…</div>
        ) : targets.length === 0 && !showAddForm ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2 text-center">
            <p className="text-sm text-[var(--text-secondary)]">No publish targets configured.</p>
            <p className="text-xs text-[var(--text-secondary)] max-w-xs">Add Slack, email, or webhook targets to automatically deliver agent output.</p>
            <Button size="sm" variant="outline" className="mt-2 gap-1.5" onClick={() => setShowAddForm(true)}>
              <Plus className="h-3.5 w-3.5" /> Add your first publish target
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {myTargets.length > 0 && (
              <>
                <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-secondary)] px-3 py-1.5">
                  My Targets <span className="ml-1 opacity-60">{myTargets.length}</span>
                </div>
                {myTargets.map(target => <TargetRow key={target.id} target={target} isOwner onShare={() => setShareTargetId(target.id)} />)}
              </>
            )}
            {sharedTargets.length > 0 && (
              <>
                <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-secondary)] px-3 py-1.5">
                  Shared with Me <span className="ml-1 opacity-60">{sharedTargets.length}</span>
                </div>
                {sharedTargets.map(target => <TargetRow key={target.id} target={target} isOwner={false} onShare={() => {}} />)}
              </>
            )}
          </div>
        )}
      </div>

      {shareTargetId && (
        <ShareDialog
          entityType="publishTarget"
          entityId={shareTargetId}
          isOpen={!!shareTargetId}
          onClose={() => setShareTargetId(null)}
        />
      )}
    </div>
  )
}
