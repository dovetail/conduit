import React, { useState, useEffect } from 'react'
import { Plus, Pencil, Trash2, Info, Loader2, X, Check, RefreshCw, FolderGit2, ExternalLink, Share2, Upload } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { ShareDialog } from '@renderer/components/ShareDialog'
import { api } from '@renderer/lib/ipc'
import {
  useRepositories,
  useCreateRepository,
  useUpdateRepository,
  useDeleteRepository,
  useTriggerRepoSync,
  useTestRepoConnection,
  useRepoSyncEvents,
} from '@renderer/hooks/useRepositories'
import { useAuth } from '@renderer/contexts/AuthContext'
import { cn } from '@renderer/lib/utils'
import type { Repository, RepoSyncStatus, RepoAuthMethod, RepositoryInput } from '@shared/types'

function statusColor(status: RepoSyncStatus): string {
  switch (status) {
    case 'ready': return 'bg-green-500'
    case 'cloning':
    case 'syncing': return 'bg-yellow-500'
    case 'error': return 'bg-red-500'
    case 'pending':
    default: return 'bg-[var(--text-secondary)]'
  }
}

function statusLabel(status: RepoSyncStatus): string {
  switch (status) {
    case 'ready': return 'Ready'
    case 'cloning': return 'Cloning...'
    case 'syncing': return 'Syncing...'
    case 'error': return 'Error'
    case 'pending': return 'Pending'
    default: return status
  }
}

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

interface FormState {
  name: string
  url: string
  defaultBranch: string
  authMethod: RepoAuthMethod
  githubAppId: string
  /** Newly-uploaded PEM this session — empty means "leave the stored key untouched". */
  githubPrivateKey: string
  /** Whether the repo already has a stored GitHub App key. */
  hasGithubKey: boolean
  commitAuthorName: string
  commitAuthorEmail: string
}

function emptyForm(): FormState {
  return {
    name: '',
    url: '',
    defaultBranch: 'main',
    authMethod: 'none',
    githubAppId: '',
    githubPrivateKey: '',
    hasGithubKey: false,
    commitAuthorName: '',
    commitAuthorEmail: '',
  }
}

function formFromRepo(repo: Repository): FormState {
  return {
    name: repo.name,
    url: repo.url,
    defaultBranch: repo.defaultBranch,
    authMethod: repo.authMethod,
    githubAppId: repo.githubAppId ?? '',
    githubPrivateKey: '',
    hasGithubKey: !!repo.hasGithubKey,
    commitAuthorName: repo.commitAuthorName ?? '',
    commitAuthorEmail: repo.commitAuthorEmail ?? '',
  }
}

/** Build the create/update payload, including GitHub App fields only when relevant. */
function formToInput(form: FormState): RepositoryInput {
  const base: RepositoryInput = {
    name: form.name.trim(),
    url: form.url.trim(),
    defaultBranch: form.defaultBranch.trim(),
    authMethod: form.authMethod,
    commitAuthorName: form.commitAuthorName.trim() || undefined,
    commitAuthorEmail: form.commitAuthorEmail.trim() || undefined,
  }
  if (form.authMethod === 'githubapp') {
    base.githubAppId = form.githubAppId.trim()
    // Only send a key when a new one was uploaded; otherwise leave the stored one.
    if (form.githubPrivateKey) base.githubPrivateKey = form.githubPrivateKey
  }
  return base
}

const AUTH_METHODS: { value: RepoAuthMethod; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'pat', label: 'PAT' },
  { value: 'ssh', label: 'SSH' },
  { value: 'githubapp', label: 'GitHub App' },
]

interface InlineFormProps {
  initial: FormState
  onSave: (form: FormState) => void
  onCancel: () => void
  saving: boolean
  /** Existing repo id — lets Test Connection reuse a stored key when no new PEM is uploaded. */
  repoId?: string
}

function InlineForm({ initial, onSave, onCancel, saving, repoId }: InlineFormProps) {
  const [form, setForm] = useState<FormState>(initial)
  const testMutation = useTestRepoConnection()
  const [pat, setPat] = useState('')
  const [patStatus, setPatStatus] = useState<'loading' | 'configured' | 'missing'>('loading')
  const [patSaving, setPatSaving] = useState(false)
  const [keyFileName, setKeyFileName] = useState('')

  const handleKeyFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      setForm((f) => ({ ...f, githubPrivateKey: String(reader.result ?? '') }))
      setKeyFileName(file.name)
    }
    reader.readAsText(file)
  }

  // Check if a PAT is already configured
  useEffect(() => {
    api.prefs.get<string>('githubPat').then((val) => {
      setPatStatus(val ? 'configured' : 'missing')
    }).catch(() => setPatStatus('missing'))
  }, [])

  const handleSavePat = async () => {
    if (!pat.trim()) return
    setPatSaving(true)
    try {
      await api.prefs.set('githubPat', pat.trim())
      setPat('')
      setPatStatus('configured')
    } catch {
      // ignore
    } finally {
      setPatSaving(false)
    }
  }

  const githubAppValid =
    form.authMethod !== 'githubapp' ||
    (form.githubAppId.trim().length > 0 && (form.hasGithubKey || form.githubPrivateKey.length > 0))
  const isValid =
    form.name.trim().length > 0 &&
    form.url.trim().length > 0 &&
    form.defaultBranch.trim().length > 0 &&
    githubAppValid
  const canTest = form.url.trim().length > 0 && githubAppValid

  const handleTest = () => {
    testMutation.reset()
    testMutation.mutate({
      url: form.url.trim(),
      authMethod: form.authMethod,
      githubAppId: form.githubAppId.trim() || undefined,
      githubPrivateKey: form.githubPrivateKey || undefined,
      repoId,
    })
  }

  return (
    <div className="border border-[var(--border)] rounded-lg bg-[var(--bg-secondary)] p-4 space-y-4">
      {/* Name */}
      <div className="space-y-1">
        <label className="block text-xs font-medium text-[var(--text-secondary)]">
          Repository Name
        </label>
        <Input
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="e.g. conduit"
          autoFocus
        />
      </div>

      {/* Clone URL */}
      <div className="space-y-1">
        <label className="block text-xs font-medium text-[var(--text-secondary)]">
          Clone URL
        </label>
        <Input
          value={form.url}
          onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
          placeholder="https://github.com/org/repo.git"
          className="font-mono text-xs"
        />
      </div>

      {/* Default Branch */}
      <div className="space-y-1">
        <label className="block text-xs font-medium text-[var(--text-secondary)]">
          Default Branch
        </label>
        <Input
          value={form.defaultBranch}
          onChange={(e) => setForm((f) => ({ ...f, defaultBranch: e.target.value }))}
          placeholder="main"
          className="text-xs w-48"
        />
      </div>

      {/* Commit identity ("commit as") */}
      <div className="space-y-1">
        <label className="block text-xs font-medium text-[var(--text-secondary)]">
          Commit As
        </label>
        <div className="flex gap-2">
          <Input
            value={form.commitAuthorName}
            onChange={(e) => setForm((f) => ({ ...f, commitAuthorName: e.target.value }))}
            placeholder="Conduit"
            className="text-xs flex-1"
          />
          <Input
            value={form.commitAuthorEmail}
            onChange={(e) => setForm((f) => ({ ...f, commitAuthorEmail: e.target.value }))}
            placeholder="conduit@dovetail.com"
            className="font-mono text-xs flex-1"
          />
        </div>
        <p className="text-[10px] text-[var(--text-secondary)] opacity-70">
          Name & email used as the git author/committer when agents commit and push in this repo.
          Defaults to <code className="font-mono">Conduit &lt;conduit@dovetail.com&gt;</code> if blank.
        </p>
      </div>

      {/* Auth Method */}
      <div className="space-y-2">
        <label className="block text-xs font-medium text-[var(--text-secondary)]">
          Authentication
        </label>
        <div className="flex gap-1 p-0.5 rounded-md bg-[var(--bg-primary)] border border-[var(--border)]">
          {AUTH_METHODS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => setForm((f) => ({ ...f, authMethod: value }))}
              className={cn(
                'flex-1 text-xs py-1.5 rounded-md transition-colors font-medium whitespace-nowrap',
                form.authMethod === value
                  ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {form.authMethod === 'pat' ? (
          <div className="space-y-2">
            {patStatus === 'configured' ? (
              <div className="flex items-center gap-2 text-xs">
                <div className="w-2 h-2 rounded-full bg-green-500" />
                <span className="text-[var(--text-secondary)]">GitHub PAT configured</span>
                <button
                  type="button"
                  onClick={() => setPatStatus('missing')}
                  className="text-[var(--accent)] hover:underline ml-1"
                >
                  Update
                </button>
              </div>
            ) : patStatus === 'loading' ? (
              <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                <Loader2 className="h-3 w-3 animate-spin" />
                Checking...
              </div>
            ) : (
              <div className="space-y-2">
                <div className="space-y-1">
                  <label className="block text-xs text-[var(--text-secondary)]">
                    GitHub Personal Access Token
                  </label>
                  <div className="flex gap-2">
                    <Input
                      type="password"
                      value={pat}
                      onChange={(e) => setPat(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleSavePat() }}
                      placeholder="ghp_..."
                      className="font-mono text-xs flex-1"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleSavePat}
                      disabled={!pat.trim() || patSaving}
                    >
                      {patSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save'}
                    </Button>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => api.shell.openExternal('https://github.com/settings/tokens/new?scopes=repo&description=Conduit').catch(console.error)}
                  className="flex items-center gap-1.5 text-[10px] text-[var(--accent)] hover:underline"
                >
                  <ExternalLink className="h-3 w-3" />
                  Create token at github.com/settings/tokens
                </button>
              </div>
            )}
          </div>
        ) : form.authMethod === 'githubapp' ? (
          <div className="space-y-2">
            <div className="space-y-1">
              <label className="block text-xs text-[var(--text-secondary)]">
                GitHub App ID
              </label>
              <Input
                value={form.githubAppId}
                onChange={(e) => setForm((f) => ({ ...f, githubAppId: e.target.value }))}
                placeholder="e.g. 123456"
                className="font-mono text-xs w-48"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-xs text-[var(--text-secondary)]">
                Private Key (PEM)
              </label>
              {form.hasGithubKey && !form.githubPrivateKey ? (
                <div className="flex items-center gap-2 text-xs">
                  <div className="w-2 h-2 rounded-full bg-green-500" />
                  <span className="text-[var(--text-secondary)]">Private key configured</span>
                  <label className="text-[var(--accent)] hover:underline ml-1 cursor-pointer">
                    Replace
                    <input type="file" accept=".pem,.key,application/x-pem-file" className="hidden" onChange={handleKeyFile} />
                  </label>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] cursor-pointer hover:text-[var(--text-primary)] text-[var(--text-secondary)]">
                    <Upload className="h-3 w-3" />
                    {form.githubPrivateKey ? 'Key loaded' : 'Upload .pem'}
                    <input type="file" accept=".pem,.key,application/x-pem-file" className="hidden" onChange={handleKeyFile} />
                  </label>
                  {keyFileName && (
                    <span className="text-[10px] text-[var(--text-secondary)] truncate font-mono">{keyFileName}</span>
                  )}
                  {form.githubPrivateKey && (
                    <button
                      type="button"
                      onClick={() => { setForm((f) => ({ ...f, githubPrivateKey: '' })); setKeyFileName('') }}
                      className="text-[var(--text-secondary)] hover:text-red-400"
                      title="Clear"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              )}
            </div>
            <p className="text-[10px] text-[var(--text-secondary)] opacity-70">
              The key is encrypted at rest and never shown again. Requires{' '}
              <code className="font-mono">CONDUIT_SECRET_KEY</code> to be set on the server.
            </p>
            <button
              type="button"
              onClick={() => api.shell.openExternal('https://docs.github.com/apps/creating-github-apps').catch(console.error)}
              className="flex items-center gap-1.5 text-[10px] text-[var(--accent)] hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              How to create a GitHub App
            </button>
          </div>
        ) : (
          <p className="text-[10px] text-[var(--text-secondary)] opacity-70">
            {form.authMethod === 'ssh'
              ? 'Uses your system SSH agent. Ensure your key is loaded.'
              : 'No authentication — for public repositories only.'}
          </p>
        )}
      </div>

      {/* Test result */}
      {testMutation.data?.success && (
        <div className="text-xs px-3 py-2 rounded-md bg-green-500/10 text-green-400 border border-green-500/20">
          {testMutation.data.message}
        </div>
      )}
      {testMutation.data && !testMutation.data.success && (
        <div className="text-xs px-3 py-2 rounded-md bg-red-500/10 text-red-400 border border-red-500/20">
          Connection failed: {testMutation.data.message}
        </div>
      )}
      {testMutation.error && (
        <div className="text-xs px-3 py-2 rounded-md bg-red-500/10 text-red-400 border border-red-500/20">
          Test failed: {testMutation.error instanceof Error ? testMutation.error.message : String(testMutation.error)}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between pt-1">
        <Button
          variant="outline"
          size="sm"
          onClick={handleTest}
          disabled={!canTest || testMutation.isPending}
          className="gap-1.5 text-xs"
        >
          {testMutation.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <FolderGit2 className="h-3 w-3" />
          )}
          Test Connection
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => onSave(form)} disabled={!isValid || saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}

interface RepoRowProps {
  repo: Repository
  isOwner: boolean
  onShare: () => void
}

function RepoRow({ repo, isOwner, onShare }: RepoRowProps) {
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const updateRepo = useUpdateRepository()
  const deleteRepo = useDeleteRepository()
  const triggerSync = useTriggerRepoSync()

  const handleSave = (form: FormState) => {
    updateRepo.mutate(
      { id: repo.id, data: formToInput(form) },
      { onSuccess: () => setEditing(false) }
    )
  }

  const handleDelete = () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    deleteRepo.mutate(repo.id)
  }

  if (editing) {
    return (
      <InlineForm
        initial={formFromRepo(repo)}
        onSave={handleSave}
        onCancel={() => setEditing(false)}
        saving={updateRepo.isPending}
        repoId={repo.id}
      />
    )
  }

  const isBusy = repo.syncStatus === 'cloning' || repo.syncStatus === 'syncing'

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] transition-colors">
      {/* Status dot */}
      <div
        className={cn('w-2.5 h-2.5 rounded-full flex-shrink-0', statusColor(repo.syncStatus))}
        title={statusLabel(repo.syncStatus)}
      />

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-[var(--text-primary)] truncate">
            {repo.name}
          </p>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-primary)] text-[var(--text-secondary)] font-mono flex-shrink-0">
            {repo.defaultBranch}
          </span>
        </div>
        <p className="text-xs text-[var(--text-secondary)] truncate font-mono">
          {repo.url}
        </p>
        {repo.syncStatus === 'error' && repo.syncError && (
          <p className="text-xs text-red-400 truncate mt-0.5">
            {repo.syncError}
          </p>
        )}
        {repo.lastSyncedAt && (
          <p className="text-[10px] text-[var(--text-secondary)] opacity-60 mt-0.5">
            Synced {formatRelativeTime(repo.lastSyncedAt)}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 flex-shrink-0">
        {isOwner && (
          <button
            onClick={onShare}
            className="p-1.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)] transition-colors"
            title="Share"
          >
            <Share2 className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          onClick={() => triggerSync.mutate(repo.id)}
          disabled={isBusy || triggerSync.isPending}
          className="p-1.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-40"
          title="Sync now"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', isBusy && 'animate-spin')} />
        </button>
        <button
          onClick={() => { setEditing(true); setConfirmDelete(false) }}
          className="p-1.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)] transition-colors"
          title="Edit"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        {confirmDelete ? (
          <>
            <span className="text-xs text-red-400 ml-1">Delete?</span>
            <button
              onClick={handleDelete}
              disabled={deleteRepo.isPending}
              className="p-1.5 rounded-md text-red-400 hover:bg-red-400/10 transition-colors"
              title="Confirm delete"
            >
              {deleteRepo.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="p-1.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-primary)] transition-colors"
              title="Cancel"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </>
        ) : (
          <button
            onClick={handleDelete}
            className="p-1.5 rounded-md text-[var(--text-secondary)] hover:bg-red-400/10 hover:text-red-400 transition-colors"
            title="Delete"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

export function RepositoryManager() {
  const { data: repos = [], isLoading } = useRepositories()
  const { user } = useAuth()
  const createRepo = useCreateRepository()
  useRepoSyncEvents()

  const [showAddForm, setShowAddForm] = useState(false)
  const [shareRepoId, setShareRepoId] = useState<string | null>(null)

  const handleCreate = (form: FormState) => {
    createRepo.mutate(formToInput(form), { onSuccess: () => setShowAddForm(false) })
  }

  const myRepos = repos.filter((r) => r.ownerId === user?.id)
  const sharedRepos = repos.filter((r) => r.ownerId !== user?.id)

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)] flex-shrink-0">
        <div>
          <h1 className="text-sm font-semibold text-[var(--text-primary)]">Repositories</h1>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">
            Git repositories for agent workspaces
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => setShowAddForm(true)}
          disabled={showAddForm}
          className="gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {/* Info banner */}
        <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-[var(--accent)]/10 border border-[var(--accent)]/20 text-xs text-[var(--text-secondary)]">
          <Info className="h-3.5 w-3.5 text-[var(--accent)] flex-shrink-0 mt-0.5" />
          <span>
            Repositories are cloned and kept up-to-date in the background. Assign a repo to an agent
            and each run gets an isolated worktree — no manual cloning needed.
          </span>
        </div>

        {/* Add form */}
        {showAddForm && (
          <InlineForm
            initial={emptyForm()}
            onSave={handleCreate}
            onCancel={() => setShowAddForm(false)}
            saving={createRepo.isPending}
          />
        )}

        {/* Repo list */}
        {isLoading ? (
          <div className="flex items-center justify-center py-10 text-sm text-[var(--text-secondary)]">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Loading...
          </div>
        ) : repos.length === 0 && !showAddForm ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2 text-center">
            <div className="w-12 h-12 rounded-xl bg-[var(--accent)]/10 flex items-center justify-center mb-2">
              <FolderGit2 className="h-6 w-6 text-[var(--accent)] opacity-60" />
            </div>
            <p className="text-sm text-[var(--text-secondary)]">No repositories configured.</p>
            <p className="text-xs text-[var(--text-secondary)] max-w-xs">
              Add a git repository to provide managed workspaces for your agents.
            </p>
            <Button size="sm" variant="outline" className="mt-2 gap-1.5" onClick={() => setShowAddForm(true)}>
              <Plus className="h-3.5 w-3.5" />
              Add your first repository
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {myRepos.length > 0 && (
              <>
                <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-secondary)] px-3 py-1.5">
                  My Repositories <span className="ml-1 opacity-60">{myRepos.length}</span>
                </div>
                {myRepos.map((repo) => (
                  <RepoRow key={repo.id} repo={repo} isOwner onShare={() => setShareRepoId(repo.id)} />
                ))}
              </>
            )}
            {sharedRepos.length > 0 && (
              <>
                <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-secondary)] px-3 py-1.5">
                  Shared with Me <span className="ml-1 opacity-60">{sharedRepos.length}</span>
                </div>
                {sharedRepos.map((repo) => (
                  <RepoRow key={repo.id} repo={repo} isOwner={false} onShare={() => {}} />
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {shareRepoId && (
        <ShareDialog
          entityType="repository"
          entityId={shareRepoId}
          isOpen={!!shareRepoId}
          onClose={() => setShareRepoId(null)}
        />
      )}
    </div>
  )
}
