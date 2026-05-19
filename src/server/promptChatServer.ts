import Anthropic from '@anthropic-ai/sdk'
import type { RunnerType } from '../shared/types'
import { getAgent } from '../main/db/queries/agents'

interface Session {
  id: string
  agentId: string
  runner: RunnerType
  messages: { role: 'user' | 'assistant'; content: string }[]
}

const sessions = new Map<string, Session>()

function runnerDescription(runner: RunnerType): string {
  switch (runner) {
    case 'claude':
      return 'Claude Code — autonomous coding agent with full file system access'
    case 'amp':
      return 'Amp — AI coding agent'
    case 'cursor':
      return 'Cursor — AI code editor'
  }
}

function buildSystemPrompt(agent: { name: string; runner: RunnerType; prompt: string }): string {
  return `You are an expert AI agent prompt engineer helping to craft an effective prompt for an autonomous AI agent.

Agent details:
- Name: "${agent.name}"
- CLI Runner: ${agent.runner} (${runnerDescription(agent.runner)})
- Current prompt: ${agent.prompt ? `"""${agent.prompt}"""` : '(empty — starting fresh)'}

Your role:
1. Have a natural conversation to understand what the user wants the agent to do
2. Ask clarifying questions about: task scope, input/output expectations, tools to use, constraints
3. Iteratively refine the prompt based on feedback
4. When you have a solid prompt ready to propose, present it inside a code block tagged with \`\`\`prompt
5. After proposing, ask if they'd like any changes

Tips for great agent prompts:
- Be specific about the task and success criteria
- Mention what tools/files the agent should use or avoid
- Include context about the workspace structure if relevant
- Specify output format (files to create, what to print, etc.)
- Keep it focused — one clear primary objective

Start by warmly greeting the user and asking them to describe what they want this agent to do.`
}

function extractPromptFromContent(content: string): string | undefined {
  const match = content.match(/```prompt\n([\s\S]*?)\n```/)
  return match?.[1]?.trim()
}

function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY environment variable is not set. Add it to your agent's environment variables or set it globally."
    )
  }
  return new Anthropic({ apiKey })
}

export async function createSession(agentId: string, runner: RunnerType): Promise<string> {
  const sessionId = crypto.randomUUID()
  sessions.set(sessionId, { id: sessionId, agentId, runner, messages: [] })
  return sessionId
}

export async function sendMessageServer(
  sessionId: string,
  userMessage: string,
  broadcast: (channel: string, payload: unknown) => void
): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session) throw new Error(`Session ${sessionId} not found`)

  session.messages.push({ role: 'user', content: userMessage })

  const agent = await getAgent(session.agentId)
  if (!agent) throw new Error('Agent not found')

  const client = getAnthropicClient()

  try {
    const stream = await client.messages.stream({
      model: 'claude-opus-4-5',
      max_tokens: 2048,
      system: buildSystemPrompt(agent),
      messages: session.messages,
    })

    let fullContent = ''

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        const token = event.delta.text
        fullContent += token
        broadcast('promptChat:token', { sessionId, token })
      }
    }

    session.messages.push({ role: 'assistant', content: fullContent })

    const extractedPrompt = extractPromptFromContent(fullContent)

    broadcast('promptChat:done', { sessionId, extractedPrompt })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    broadcast('promptChat:error', { sessionId, error: message })
  }
}

export function closeSession(sessionId: string): void {
  sessions.delete(sessionId)
}
