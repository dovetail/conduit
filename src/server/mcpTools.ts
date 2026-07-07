import { spawn } from 'child_process'
import type { McpServerEntry, McpToolsResult } from '../shared/types'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

function makeInitialize(): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'conduit', version: '0.1.0' },
    },
  }
}

function makeToolsList(): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  }
}

async function listToolsStdio(config: McpServerEntry): Promise<McpToolsResult> {
  const command = config.command ?? ''
  const args = config.args ?? []

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...config.env },
    })

    let stdout = ''
    let resolved = false

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        child.kill('SIGTERM')
        resolve({ tools: [], error: 'Timeout waiting for MCP server response' })
      }
    }, 15000)

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString('utf8')

      // Parse NDJSON lines — look for the tools/list response (id: 2)
      const lines = stdout.split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const msg = JSON.parse(trimmed) as JsonRpcResponse
          if (msg.id === 2 && !resolved) {
            resolved = true
            clearTimeout(timeout)
            child.kill('SIGTERM')

            if (msg.error) {
              resolve({ tools: [], error: msg.error.message })
              return
            }

            const result = msg.result as { tools?: Array<{ name: string; description?: string }> } | undefined
            const tools = (result?.tools ?? []).map((t) => ({
              name: t.name,
              description: t.description,
            }))
            resolve({ tools })
            return
          }

          // After receiving initialize response (id: 1), send initialized notification + tools/list
          if (msg.id === 1) {
            // Send initialized notification
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
            // Send tools/list
            child.stdin.write(JSON.stringify(makeToolsList()) + '\n')
          }
        } catch {
          // Not valid JSON yet, continue
        }
      }
    })

    child.on('error', (err) => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        resolve({ tools: [], error: err.message })
      }
    })

    child.on('close', () => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        resolve({ tools: [], error: 'MCP server process exited before responding' })
      }
    })

    // Send initialize request
    child.stdin.write(JSON.stringify(makeInitialize()) + '\n')
  })
}

async function listToolsUrl(config: McpServerEntry): Promise<McpToolsResult> {
  const url = config.url
  if (!url) return { tools: [], error: 'No URL configured' }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...config.headers,
  }

  try {
    // Send initialize
    const initRes = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(makeInitialize()),
      signal: AbortSignal.timeout(10000),
    })

    if (!initRes.ok) {
      return { tools: [], error: `HTTP ${initRes.status} ${initRes.statusText}` }
    }

    // Check if response is SSE or JSON
    const contentType = initRes.headers.get('content-type') ?? ''

    // Look for Mcp-Session-Id header
    const sessionId = initRes.headers.get('mcp-session-id') ?? undefined

    if (contentType.includes('text/event-stream')) {
      // Parse SSE response for initialize result
      const text = await initRes.text()
      // SSE format: "event: message\ndata: {...}\n\n"
      const dataLines = text.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6))
      // We don't strictly need to parse the init response, just proceed
    } else {
      // JSON response — read it
      await initRes.text()
    }

    // Send initialized notification
    const notifHeaders = { ...headers }
    if (sessionId) notifHeaders['mcp-session-id'] = sessionId
    await fetch(url, {
      method: 'POST',
      headers: notifHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {})

    // Send tools/list
    const toolsHeaders = { ...headers }
    if (sessionId) toolsHeaders['mcp-session-id'] = sessionId
    const toolsRes = await fetch(url, {
      method: 'POST',
      headers: toolsHeaders,
      body: JSON.stringify(makeToolsList()),
      signal: AbortSignal.timeout(10000),
    })

    if (!toolsRes.ok) {
      return { tools: [], error: `tools/list failed: HTTP ${toolsRes.status}` }
    }

    const toolsContentType = toolsRes.headers.get('content-type') ?? ''
    let toolsData: JsonRpcResponse

    if (toolsContentType.includes('text/event-stream')) {
      const text = await toolsRes.text()
      const dataLines = text.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6))
      // Find the JSON-RPC response
      toolsData = JSON.parse(dataLines[dataLines.length - 1]) as JsonRpcResponse
    } else {
      toolsData = await toolsRes.json() as JsonRpcResponse
    }

    if (toolsData.error) {
      return { tools: [], error: toolsData.error.message }
    }

    const result = toolsData.result as { tools?: Array<{ name: string; description?: string }> } | undefined
    const tools = (result?.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
    }))
    return { tools }
  } catch (err) {
    return { tools: [], error: err instanceof Error ? err.message : String(err) }
  }
}

export async function listMcpTools(config: McpServerEntry): Promise<McpToolsResult> {
  const isUrl = config.type === 'url' || !!config.url
  if (isUrl) {
    return listToolsUrl(config)
  }
  return listToolsStdio(config)
}
