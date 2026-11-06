import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { reporter } from '../observability'
import { isClientError } from '../errors'
import type { McpCaller, McpDeps } from './context'

export interface ToolEnv {
  caller: McpCaller
  deps: McpDeps
}

export interface ToolSpec<S extends z.ZodRawShape> {
  name: string
  title: string
  description: string
  input: S
  /** 'write' tools are only registered for write-scoped callers. */
  access: 'read' | 'write'
  destructive?: boolean
  idempotent?: boolean
  /** True when the tool reaches outside Conduit (e.g. probes an MCP server URL). */
  openWorld?: boolean
  run: (args: z.infer<z.ZodObject<S>>, env: ToolEnv) => Promise<unknown>
}

export function jsonText(data: unknown): string {
  return JSON.stringify(data, null, 2)
}

function toResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : jsonText(data) }] }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function registerTool<S extends z.ZodRawShape>(
  server: McpServer,
  env: ToolEnv,
  spec: ToolSpec<S>
): void {
  if (spec.access === 'write' && env.caller.scope !== 'write') return
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.input,
      annotations: {
        title: spec.title,
        readOnlyHint: spec.access === 'read',
        destructiveHint: spec.access === 'write' ? !!spec.destructive : undefined,
        idempotentHint: spec.idempotent,
        openWorldHint: !!spec.openWorld,
      },
    },
    // The SDK has already validated `args` against `spec.input`.
    (async (args: unknown): Promise<CallToolResult> => {
      if (spec.access === 'write') {
        console.log(
          `[mcp] ${spec.name} by user=${env.caller.userId}` +
            (env.caller.tokenName ? ` token="${env.caller.tokenName}"` : ` auth=${env.caller.authKind}`)
        )
      }
      try {
        return toResult(await spec.run(args as z.infer<z.ZodObject<S>>, env))
      } catch (err) {
        if (!isClientError(err)) {
          reporter.captureException(err, {
            tags: { component: 'mcp', tool: spec.name },
            user: { id: env.caller.userId },
          })
        }
        return { isError: true, content: [{ type: 'text', text: errorMessage(err) }] }
      }
    }) as never
  )
}
