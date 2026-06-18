import cron, { type ScheduledTask } from 'node-cron'
import type { Trigger, TriggerContext, CronTriggerConfig, ExecutionRun } from '../../shared/types'
import { listAllEnabledTriggers, getTrigger, updateTrigger } from '../../main/db/queries/triggers'
import { startRunServer } from '../runner'

type BroadcastFn = (channel: string, payload: unknown) => void

export class TriggerService {
  private cronJobs = new Map<string, ScheduledTask>()
  private broadcast: BroadcastFn

  constructor(broadcast: BroadcastFn) {
    this.broadcast = broadcast
  }

  /** Load all enabled triggers from DB and register cron jobs. Called at server startup. */
  async start(): Promise<void> {
    const triggers = await listAllEnabledTriggers()
    let cronCount = 0
    for (const trigger of triggers) {
      if (trigger.type === 'cron') {
        this.registerCron(trigger)
        cronCount++
      }
    }
    if (cronCount > 0) {
      console.log(`[triggers] Registered ${cronCount} cron trigger(s)`)
    }
  }

  stop(): void {
    for (const [id, task] of this.cronJobs) {
      task.stop()
    }
    this.cronJobs.clear()
  }

  /** Register or re-register a trigger (called on create/update). */
  registerTrigger(trigger: Trigger): void {
    // Unregister first if exists
    this.unregisterTrigger(trigger.id)

    if (!trigger.enabled) return

    if (trigger.type === 'cron') {
      this.registerCron(trigger)
    }
    // Slack and webhook triggers are stateless — they respond to inbound HTTP requests
  }

  /** Unregister a trigger (called on delete/disable). */
  unregisterTrigger(triggerId: string): void {
    const existing = this.cronJobs.get(triggerId)
    if (existing) {
      existing.stop()
      this.cronJobs.delete(triggerId)
    }
  }

  /** Execute a trigger — start an agent run with optional context. */
  async executeTrigger(triggerId: string, context?: TriggerContext): Promise<ExecutionRun | null> {
    const trigger = await getTrigger(triggerId)
    if (!trigger || !trigger.enabled) {
      console.warn(`[triggers] Trigger ${triggerId} not found or disabled`)
      return null
    }

    try {
      const triggerContext: TriggerContext = context ?? {
        triggerId: trigger.id,
        triggerType: trigger.type,
      }
      // Ensure triggerId and type are set
      triggerContext.triggerId = trigger.id
      triggerContext.triggerType = trigger.type

      const run = await startRunServer(trigger.agentId, this.broadcast, triggerContext)

      // Update lastTriggeredAt
      await updateTrigger(trigger.id, { lastTriggeredAt: Date.now() })

      // Broadcast trigger:fired event
      this.broadcast('trigger:fired', {
        triggerId: trigger.id,
        agentId: trigger.agentId,
        runId: run.id,
        triggerType: trigger.type,
      })

      console.log(`[triggers] Fired trigger "${trigger.name}" (${trigger.type}) → run ${run.id}`)
      return run
    } catch (err) {
      console.error(`[triggers] Failed to execute trigger "${trigger.name}":`, err)
      return null
    }
  }

  private registerCron(trigger: Trigger): void {
    const config = trigger.config as CronTriggerConfig
    if (!config.expression) return

    const options: { timezone?: string } = {}
    if (config.timezone) options.timezone = config.timezone

    try {
      const task = cron.schedule(config.expression, () => {
        this.executeTrigger(trigger.id)
      }, options)

      this.cronJobs.set(trigger.id, task)
    } catch (err) {
      console.error(`[triggers] Invalid cron expression for trigger "${trigger.name}":`, err)
    }
  }
}
