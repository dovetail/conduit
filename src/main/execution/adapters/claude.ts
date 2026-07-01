/**
 * Build the CLI arguments for the `claude` binary.
 * The prompt is NOT included here — it is written to stdin after spawn to avoid
 * being consumed by --mcp-config's variadic <configs...> parser.
 *
 * `effort` maps to `claude --effort <level>`; when omitted the CLI default applies.
 * `strictMcp` adds `--strict-mcp-config` so ONLY the injected --mcp-config servers
 * load — ignoring the repo's own `.mcp.json` and the host's personal connectors.
 */
export function buildClaudeArgs(mcpConfigPath: string, effort?: string, strictMcp = false): string[] {
  return [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--model',
    'claude-opus-4-6',
    '--dangerously-skip-permissions',
    ...(effort ? ['--effort', effort] : []),
    ...(strictMcp ? ['--strict-mcp-config'] : []),
    '--mcp-config',
    mcpConfigPath,
  ]
}

interface ContentBlock {
  type: string
  text?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: unknown
}

interface ClaudeStreamEvent {
  type: string
  message?: {
    role?: string
    content?: ContentBlock[]
  }
  result?: string
  subtype?: string
}

// ── ANSI helpers ─────────────────────────────────────────────────────────────

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const CYAN = '\x1b[36m'
const YELLOW = '\x1b[33m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const GRAY = '\x1b[90m'
const WHITE = '\x1b[37m'
const BG_GRAY = '\x1b[48;5;236m'

const MAX_RESULT_LINES = 20
const MAX_RESULT_CHARS = 2000

// ── Tool formatting ──────────────────────────────────────────────────────────

/** Format a tool_use block into a readable one-liner. */
function formatToolUse(block: ContentBlock): string {
  const name = block.name ?? 'tool'
  const input = block.input ?? {}

  const icon = `${YELLOW}❯${RESET}`
  const tag = `${BOLD}${WHITE}${name}${RESET}`

  if (name === 'Bash' && input.command) {
    const cmd = String(input.command)
    const display = cmd.length > 200 ? cmd.slice(0, 200) + '…' : cmd
    return `${icon} ${tag} ${GRAY}$ ${display}${RESET}`
  }
  if (name === 'Read' && input.file_path) {
    return `${icon} ${tag} ${GRAY}${input.file_path}${RESET}`
  }
  if (name === 'Write' && input.file_path) {
    return `${icon} ${tag} ${GRAY}${input.file_path}${RESET}`
  }
  if (name === 'Edit' && input.file_path) {
    return `${icon} ${tag} ${GRAY}${input.file_path}${RESET}`
  }
  if (name === 'Glob' && input.pattern) {
    return `${icon} ${tag} ${GRAY}${input.pattern}${RESET}`
  }
  if (name === 'Grep' && input.pattern) {
    const path = input.path ? ` in ${input.path}` : ''
    return `${icon} ${tag} ${GRAY}/${input.pattern}/${path}${RESET}`
  }
  if (name === 'Agent' && input.prompt) {
    const desc = String(input.prompt).slice(0, 120)
    return `${icon} ${tag} ${GRAY}${desc}…${RESET}`
  }
  if (name === 'TodoWrite' || name === 'ToolSearch') {
    return `${icon} ${tag}`
  }
  // MCP tool calls
  if (name.startsWith('mcp__')) {
    const parts = name.split('__')
    const server = parts[1] ?? '?'
    const tool = parts.slice(2).join('__') || '?'
    return `${icon} ${BOLD}${WHITE}${tool}${RESET} ${GRAY}(${server})${RESET}`
  }
  return `${icon} ${tag}`
}

/** Truncate and format tool result text for display. */
function formatToolResult(text: string): string | null {
  if (!text.trim()) return null

  // Handle <persisted-output> blocks — just show the summary
  if (text.includes('<persisted-output>')) {
    const match = text.match(/Output too large \(([^)]+)\)/)
    const size = match ? match[1] : 'large'
    return `${DIM}${GRAY}  ↳ Output too large (${size}) — saved to disk${RESET}`
  }

  // Skip noisy system responses
  if (text.startsWith('Todos have been modified')) return null
  if (text.startsWith('File created successfully')) {
    return `${GREEN}  ✓ File created${RESET}`
  }
  if (text.match(/^The file .+ has been updated successfully/)) {
    return `${GREEN}  ✓ File updated${RESET}`
  }
  if (text.startsWith('File does not exist')) {
    return `${RED}  ✗ File not found${RESET}`
  }

  // Check for exit code lines (from Bash results)
  const exitMatch = text.match(/^Exit code (\d+)$/m)

  const lines = text.split('\n')
  let truncated = false
  let display: string[]

  if (lines.length > MAX_RESULT_LINES || text.length > MAX_RESULT_CHARS) {
    truncated = true
    // Show first and last few lines
    const headCount = Math.min(8, Math.floor(MAX_RESULT_LINES / 2))
    const tailCount = Math.min(5, MAX_RESULT_LINES - headCount - 1)
    const head = lines.slice(0, headCount)
    const tail = lines.slice(-tailCount)
    const omitted = lines.length - headCount - tailCount
    display = [
      ...head,
      `${DIM}  … ${omitted} lines omitted …${RESET}`,
      ...tail,
    ]
  } else {
    display = lines
  }

  // Indent and dim the output
  const formatted = display
    .map((l) => `${DIM}  ${l}${RESET}`)
    .join('\n')

  // Add exit code indicator if non-zero
  if (exitMatch && exitMatch[1] !== '0') {
    return `${RED}  Exit code ${exitMatch[1]}${RESET}\n${formatted}`
  }

  return formatted
}

/** Extract text from a tool_result content value. */
function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: string; text: string } => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
  }
  return ''
}

// ── Main parser ──────────────────────────────────────────────────────────────

/**
 * Parse a single NDJSON line from the claude --output-format stream-json output.
 * Returns a human-readable string (possibly with ANSI codes), or null to skip.
 */
export function parseClaudeOutput(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  let event: ClaudeStreamEvent
  try {
    event = JSON.parse(trimmed)
  } catch {
    // Not JSON — pass through as-is (startup messages etc.)
    return trimmed
  }

  switch (event.type) {
    case 'assistant': {
      const blocks = event.message?.content ?? []
      const parts: string[] = []
      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          // Agent narration — styled distinctly
          parts.push(`${CYAN}${block.text}${RESET}`)
        } else if (block.type === 'tool_use') {
          parts.push(formatToolUse(block))
        }
        // skip 'thinking' blocks
      }
      return parts.length > 0 ? parts.join('\n') : null
    }

    case 'user': {
      // Tool results arrive as user messages
      const blocks = event.message?.content ?? []
      const parts: string[] = []
      for (const block of blocks) {
        if (block.type === 'tool_result') {
          const text = extractToolResultText(block.content)
          const formatted = formatToolResult(text)
          if (formatted) parts.push(formatted)
        }
      }
      return parts.length > 0 ? parts.join('\n') : null
    }

    case 'result': {
      if (event.subtype === 'success') return `\n${GREEN}${BOLD}✓ Completed${RESET}`
      return `\n${RED}${BOLD}✗ Failed${RESET}`
    }

    default:
      return null
  }
}
