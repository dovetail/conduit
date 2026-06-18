import { Router, type Request, type Response } from 'express'
import * as crypto from 'crypto'
import type { TriggerService } from './triggerService'
import type { TriggerContext, SlackTriggerConfig, WebhookTriggerConfig } from '../../shared/types'
import { getTrigger, listAllEnabledTriggers } from '../../main/db/queries/triggers'
import { serverStoreGet } from '../store'

/**
 * Create Express routes for inbound trigger endpoints.
 *
 * POST /slack              — Slack Event API
 * POST /webhook/:triggerId — Generic inbound webhook
 */
export function createTriggerRoutes(triggerService: TriggerService): Router {
  const router = Router()

  // ── Slack Event API ──────────────────────────────────────────────────────

  router.post('/slack', async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>

    // 1. Verify Slack signature
    const signingSecret = serverStoreGet('slackSigningSecret') as string | undefined
    if (signingSecret) {
      const timestamp = req.headers['x-slack-request-timestamp'] as string
      const slackSig = req.headers['x-slack-signature'] as string

      if (!timestamp || !slackSig) {
        res.status(401).json({ error: 'Missing Slack signature headers' })
        return
      }

      // Reject requests older than 5 minutes (replay protection)
      const now = Math.floor(Date.now() / 1000)
      if (Math.abs(now - parseInt(timestamp)) > 300) {
        res.status(401).json({ error: 'Slack request too old' })
        return
      }

      const rawBody = JSON.stringify(body)
      const sigBasestring = `v0:${timestamp}:${rawBody}`
      const mySignature = 'v0=' + crypto.createHmac('sha256', signingSecret).update(sigBasestring).digest('hex')

      if (!crypto.timingSafeEqual(Buffer.from(mySignature), Buffer.from(slackSig))) {
        res.status(401).json({ error: 'Invalid Slack signature' })
        return
      }
    }

    // 2. Handle url_verification challenge (Slack app setup)
    if (body.type === 'url_verification') {
      res.json({ challenge: body.challenge })
      return
    }

    // 3. Handle event_callback
    if (body.type === 'event_callback') {
      const event = body.event as Record<string, unknown> | undefined
      if (!event) {
        res.status(200).send('ok')
        return
      }

      // Only handle app_mention events
      if (event.type === 'app_mention') {
        // Respond immediately (Slack requires < 3 seconds)
        res.status(200).send('ok')

        const channelId = event.channel as string
        const messageText = event.text as string
        const userId = event.user as string

        // Find matching enabled slack triggers
        const allTriggers = (await listAllEnabledTriggers()).filter(t => t.type === 'slack')
        const matching = allTriggers.filter(t => {
          const config = t.config as SlackTriggerConfig
          // Match if no channel filter or channel matches
          return !config.channelFilter || config.channelFilter === channelId
        })

        for (const trigger of matching) {
          const context: TriggerContext = {
            triggerId: trigger.id,
            triggerType: 'slack',
            payload: messageText,
            slackMeta: {
              userId,
              channelId,
              messageTs: event.ts as string,
              threadTs: event.thread_ts as string | undefined,
            },
          }
          // Fire and forget — don't block the response
          triggerService.executeTrigger(trigger.id, context)
        }

        return
      }
    }

    res.status(200).send('ok')
  })

  // ── Generic Webhook ──────────────────────────────────────────────────────

  router.post('/webhook/:triggerId', async (req: Request, res: Response) => {
    const triggerId = req.params.triggerId as string
    const trigger = await getTrigger(triggerId)

    if (!trigger || !trigger.enabled) {
      res.status(404).json({ error: 'Trigger not found or disabled' })
      return
    }

    if (trigger.type !== 'webhook') {
      res.status(400).json({ error: 'Trigger is not a webhook type' })
      return
    }

    // Verify signature if secret configured
    const config = trigger.config as WebhookTriggerConfig
    if (config.secret) {
      const signature = req.headers['x-conduit-signature'] as string
      if (!signature) {
        res.status(401).json({ error: 'Missing X-Conduit-Signature header' })
        return
      }

      const rawBody = JSON.stringify(req.body)
      const expected = 'sha256=' + crypto.createHmac('sha256', config.secret).update(rawBody).digest('hex')

      if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
        res.status(401).json({ error: 'Invalid signature' })
        return
      }
    }

    const context: TriggerContext = {
      triggerId: trigger.id,
      triggerType: 'webhook',
      payload: JSON.stringify(req.body),
    }

    const run = await triggerService.executeTrigger(triggerId, context)
    if (run) {
      res.status(202).json({ runId: run.id, status: run.status })
    } else {
      res.status(500).json({ error: 'Failed to start run' })
    }
  })

  return router
}
