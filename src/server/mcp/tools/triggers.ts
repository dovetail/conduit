import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { validate as validateCron } from 'node-cron'
import { createTrigger, deleteTrigger, listTriggers, updateTrigger } from '../../../main/db/queries/triggers'
import { ClientError } from '../../errors'
import { requireAgent, requireTrigger } from '../context'
import { REDACTED, redactTrigger } from '../redact'
import { registerTool, type ToolEnv } from '../registry'
import type { Trigger, TriggerConfig, TriggerType } from '../../../shared/types'

const triggerConfigFields = {
  cronExpression: z.string().optional().describe("Cron triggers: 5- or 6-field cron expression, e.g. '0 9 * * 1-5'."),
  timezone: z.string().optional().describe("Cron triggers: IANA timezone, e.g. 'Australia/Sydney'."),
  webhookSecret: z
    .string()
    .nullable()
    .optional()
    .describe('Webhook triggers: HMAC-SHA256 secret callers sign the body with (X-Conduit-Signature). null removes it.'),
  slackChannelFilter: z
    .string()
    .nullable()
    .optional()
    .describe('Slack triggers: only fire for app mentions in this channel id. null fires for any channel.'),
}

type ConfigFields = {
  cronExpression?: string
  timezone?: string
  webhookSecret?: string | null
  slackChannelFilter?: string | null
}

function buildConfig(type: TriggerType, fields: ConfigFields, existing?: TriggerConfig): TriggerConfig {
  const prev = (existing ?? {}) as Record<string, string | undefined>
  switch (type) {
    case 'cron': {
      const expression = fields.cronExpression ?? prev.expression
      if (!expression) throw new ClientError('Cron triggers need a cronExpression.')
      if (!validateCron(expression)) throw new ClientError(`Invalid cron expression "${expression}".`)
      const timezone = fields.timezone ?? prev.timezone
      if (timezone) {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: timezone })
        } catch {
          throw new ClientError(`Unknown timezone "${timezone}".`)
        }
      }
      return timezone ? { expression, timezone } : { expression }
    }
    case 'webhook': {
      const secret =
        fields.webhookSecret === undefined || fields.webhookSecret === REDACTED
          ? prev.secret
          : fields.webhookSecret ?? undefined
      return secret ? { secret } : {}
    }
    case 'slack': {
      const channelFilter =
        fields.slackChannelFilter === undefined ? prev.channelFilter : fields.slackChannelFilter ?? undefined
      return channelFilter ? { channelFilter } : {}
    }
  }
}

function present(trigger: Trigger, baseUrl: string) {
  return {
    ...redactTrigger(trigger),
    webhookUrl: trigger.type === 'webhook' ? `${baseUrl}/api/triggers/webhook/${trigger.id}` : undefined,
  }
}

export function registerTriggerTools(server: McpServer, env: ToolEnv): void {
  registerTool(server, env, {
    name: 'list_triggers',
    title: 'List triggers',
    description: "List an agent's triggers (cron schedules, inbound webhooks, Slack mentions).",
    access: 'read',
    input: { agentId: z.string() },
    run: async ({ agentId }, { caller, deps }) => {
      await requireAgent(caller, agentId)
      return (await listTriggers(agentId)).map((t) => present(t, deps.baseUrl))
    },
  })

  registerTool(server, env, {
    name: 'create_trigger',
    title: 'Create trigger',
    description:
      "Add a trigger that starts an agent automatically: 'cron' (schedule), 'webhook' (POST to the returned webhookUrl), or 'slack' (app mention). Cron triggers are scheduled immediately when enabled.",
    access: 'write',
    input: {
      agentId: z.string(),
      name: z.string().min(1),
      type: z.enum(['cron', 'webhook', 'slack']),
      enabled: z.boolean().optional().describe('Default true.'),
      ...triggerConfigFields,
    },
    run: async ({ agentId, name, type, enabled, ...fields }, { caller, deps }) => {
      await requireAgent(caller, agentId)
      const trigger = await createTrigger({
        agentId,
        name,
        type,
        enabled: enabled ?? true,
        config: buildConfig(type, fields),
      })
      deps.registerTrigger(trigger)
      deps.broadcast('entity:changed', { entity: 'trigger', id: trigger.id, agentId })
      return present(trigger, deps.baseUrl)
    },
  })

  registerTool(server, env, {
    name: 'update_trigger',
    title: 'Update trigger',
    description:
      'Change a trigger. Only the fields you pass change; the type cannot change (delete and recreate instead).',
    access: 'write',
    idempotent: true,
    input: {
      triggerId: z.string(),
      name: z.string().min(1).optional(),
      enabled: z.boolean().optional(),
      ...triggerConfigFields,
    },
    run: async ({ triggerId, name, enabled, ...fields }, { caller, deps }) => {
      const { trigger } = await requireTrigger(caller, triggerId)
      const hasConfigChange = Object.values(fields).some((v) => v !== undefined)
      const updated = await updateTrigger(triggerId, {
        ...(name !== undefined ? { name } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
        ...(hasConfigChange ? { config: buildConfig(trigger.type, fields, trigger.config) } : {}),
      })
      deps.registerTrigger(updated)
      deps.broadcast('entity:changed', { entity: 'trigger', id: triggerId, agentId: trigger.agentId })
      return present(updated, deps.baseUrl)
    },
  })

  registerTool(server, env, {
    name: 'delete_trigger',
    title: 'Delete trigger',
    description: 'Delete a trigger. A deleted cron trigger stops firing immediately.',
    access: 'write',
    destructive: true,
    input: { triggerId: z.string() },
    run: async ({ triggerId }, { caller, deps }) => {
      const { trigger } = await requireTrigger(caller, triggerId)
      deps.unregisterTrigger(triggerId)
      await deleteTrigger(triggerId)
      deps.broadcast('entity:changed', { entity: 'trigger', id: triggerId, agentId: trigger.agentId })
      return { deleted: true, triggerId }
    },
  })
}
