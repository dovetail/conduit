import { Router } from 'express'
import type { Request, Response } from 'express'
import { handleCallback } from './service'
import { reporter } from '../observability'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function resultPage(ok: boolean, message: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${ok ? 'Authenticated' : 'Authentication failed'} — Conduit</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0f0f0f;color:#e5e5e5}.card{text-align:center;padding:2rem;max-width:400px}h2{font-size:1.5rem;margin-bottom:.5rem;color:${ok ? '#34d399' : '#f87171'}}p{color:#a1a1aa;font-size:.9rem}</style>
</head><body><div class="card"><h2>${ok ? 'Authenticated!' : 'Authentication failed'}</h2>
<p>${ok ? 'You can close this tab and return to Conduit.' : escapeHtml(message)}</p></div></body></html>`
}

export function createMcpOAuthRouter(broadcast: (channel: string, payload: unknown) => void): Router {
  const router = Router()
  router.get('/callback', async (req: Request, res: Response) => {
    const q = req.query as Record<string, string | undefined>
    const result = await handleCallback(q)
    if (result.serverUrl) {
      broadcast('mcp:oauth:complete', { serverUrl: result.serverUrl, success: result.ok, error: result.error })
    }
    if (!result.ok) {
      // Callback failures (invalid/expired state, token-exchange errors, provider
      // rejections) are otherwise only shown in the popup — report them so MCP
      // connection problems are diagnosable in the error reporter.
      reporter.captureMessage(`MCP OAuth callback failed: ${result.error ?? 'unknown'}`, 'error', {
        tags: { kind: 'mcp_oauth_callback', serverUrl: result.serverUrl ?? 'unknown' },
        extra: { error: result.error },
      })
    }
    res.status(200).type('html').send(resultPage(result.ok, result.error ?? ''))
  })
  return router
}
