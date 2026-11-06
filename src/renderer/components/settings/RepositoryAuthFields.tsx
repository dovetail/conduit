import React, { useState } from 'react'
import { Check, Copy, ExternalLink, KeyRound, Loader2, Upload, X } from 'lucide-react'
import { Input } from '@renderer/components/ui/input'
import { api } from '@renderer/lib/ipc'
import type { RepoFormState } from './repositoryForm'

interface AuthFieldsProps {
  form: RepoFormState
  update: (patch: Partial<RepoFormState>) => void
}

const fieldLabel = 'block text-xs text-[var(--text-secondary)]'
const helpText = 'text-[10px] text-[var(--text-secondary)] opacity-70'
const chipButton =
  'flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] hover:text-[var(--text-primary)] text-[var(--text-secondary)]'

function ConfiguredBadge({ label, action }: { label: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <div className="w-2 h-2 rounded-full bg-green-500" />
      <span className="text-[var(--text-secondary)]">{label}</span>
      {action}
    </div>
  )
}

function DocsLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => api.shell.openExternal(href).catch(console.error)}
      className="flex items-center gap-1.5 text-[10px] text-[var(--accent)] hover:underline"
    >
      <ExternalLink className="h-3 w-3" />
      {children}
    </button>
  )
}

export function GitlabTokenFields({ form, update }: AuthFieldsProps) {
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <label className={fieldLabel}>GitLab Access Token</label>
        {form.hasGitlabToken && !form.gitlabToken ? (
          <ConfiguredBadge
            label="Token configured"
            action={
              <button
                type="button"
                onClick={() => update({ hasGitlabToken: false })}
                className="text-[var(--accent)] hover:underline ml-1"
              >
                Replace
              </button>
            }
          />
        ) : (
          <Input
            type="password"
            value={form.gitlabToken}
            onChange={(e) => update({ gitlabToken: e.target.value })}
            placeholder="glpat-..."
            className="font-mono text-xs"
            autoComplete="off"
          />
        )}
      </div>
      <p className={helpText}>
        A project, group, or personal access token with the <code className="font-mono">Developer</code> role
        (or higher) and <code className="font-mono">read_repository</code> + <code className="font-mono">write_repository</code>{' '}
        scopes — add <code className="font-mono">api</code> if agents should open merge requests with{' '}
        <code className="font-mono">glab</code>. Works with self-managed GitLab. The token is encrypted at rest and never
        shown again.
      </p>
      <DocsLink href="https://docs.gitlab.com/user/project/settings/project_access_tokens/">
        How to create a project access token
      </DocsLink>
    </div>
  )
}

interface SshDeployKeyFieldsProps extends AuthFieldsProps {
  /** Public key of the stored key, restored when a new key is discarded. */
  saved: Pick<RepoFormState, 'sshPublicKey' | 'sshKeyFingerprint'>
}

export function SshDeployKeyFields({ form, update, saved }: SshDeployKeyFieldsProps) {
  const [fileName, setFileName] = useState('')
  const [busy, setBusy] = useState(false)
  const [keyError, setKeyError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setKeyError(null)
    try {
      await fn()
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    void run(async () => {
      const privateKey = await file.text()
      // Validate now and show the public half, so it can be registered before saving.
      const info = await api.repos.describeSshKey(privateKey)
      update({ sshPrivateKey: privateKey, sshPublicKey: info.publicKey, sshKeyFingerprint: info.fingerprint })
      setFileName(file.name)
    })
  }

  const handleGenerate = () =>
    run(async () => {
      const pair = await api.repos.generateSshKey()
      update({ sshPrivateKey: pair.privateKey, sshPublicKey: pair.publicKey, sshKeyFingerprint: pair.fingerprint })
      setFileName('')
    })

  const handleDiscard = () => {
    update({ sshPrivateKey: '', sshPublicKey: saved.sshPublicKey, sshKeyFingerprint: saved.sshKeyFingerprint })
    setFileName('')
    setKeyError(null)
  }

  const handleCopy = () => {
    navigator.clipboard
      .writeText(form.sshPublicKey)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(console.error)
  }

  const hasKey = form.hasSshKey || !!form.sshPrivateKey

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <label className={fieldLabel}>Private Key</label>
        <div className="flex items-center gap-2 flex-wrap">
          {form.hasSshKey && !form.sshPrivateKey && (
            <span className="flex items-center gap-2 text-xs text-[var(--text-secondary)] mr-1">
              <span className="w-2 h-2 rounded-full bg-green-500" />
              Deploy key configured
            </span>
          )}
          <label className={`${chipButton} cursor-pointer`}>
            <Upload className="h-3 w-3" />
            {form.sshPrivateKey && fileName ? 'Key loaded' : form.hasSshKey ? 'Replace with file' : 'Upload key'}
            <input type="file" className="hidden" onChange={handleFile} disabled={busy} />
          </label>
          <button type="button" onClick={handleGenerate} disabled={busy} className={`${chipButton} disabled:opacity-50`}>
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <KeyRound className="h-3 w-3" />}
            {hasKey ? 'Generate new key' : 'Generate key'}
          </button>
          {fileName && <span className="text-[10px] text-[var(--text-secondary)] truncate font-mono">{fileName}</span>}
          {form.sshPrivateKey && (
            <button
              type="button"
              onClick={handleDiscard}
              className="text-[var(--text-secondary)] hover:text-red-400"
              title="Discard new key"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        {keyError && <p className="text-[10px] text-red-400">{keyError}</p>}
      </div>
      {form.sshPublicKey && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label className={fieldLabel}>Public Key — add this as a deploy key on the repository</label>
            <button
              type="button"
              onClick={handleCopy}
              className="flex items-center gap-1 text-[10px] text-[var(--accent)] hover:underline"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre className="text-[10px] font-mono whitespace-pre-wrap break-all px-2 py-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] select-all">
            {form.sshPublicKey}
          </pre>
          {form.sshKeyFingerprint && <p className={`${helpText} font-mono`}>{form.sshKeyFingerprint}</p>}
        </div>
      )}
      <div className="space-y-1">
        <label className={fieldLabel}>
          Known Hosts <span className="opacity-60">(optional)</span>
        </label>
        <textarea
          value={form.sshKnownHosts}
          onChange={(e) => update({ sshKnownHosts: e.target.value })}
          placeholder="gitlab.com ssh-ed25519 AAAA…  (leave blank to trust the host key seen on first sync)"
          rows={2}
          spellCheck={false}
          className="w-full text-[10px] font-mono px-2 py-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] placeholder:opacity-60"
        />
      </div>
      <p className={helpText}>
        Works with any git host over SSH (GitLab, GitHub, Bitbucket, self-hosted). On GitLab add the public key under
        Settings → Repository → Deploy keys and tick <em>Grant write permissions</em> so agents can push. The private
        key must not have a passphrase; it is encrypted at rest and never shown again. The host key is pinned on the
        first successful sync and checked strictly afterwards.
      </p>
    </div>
  )
}
