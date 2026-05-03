/**
 * Alert service.
 * Dispatches alerts to Telegram and Discord based on severity and channel config.
 */
import * as telegram from '../clients/telegram.js'
import { eventBus } from '../lib/eventBus.js'
import { logAlert } from '../lib/store.js'
import { createLogger } from '../lib/logger.js'
import { config } from '../config/index.js'
import type { Alert, AlertSeverity, DiscordWebhookPayload, DiscordEmbed } from '../types/alerts.js'
import { withRetry } from '../lib/retry.js'

const log = createLogger('alert-service')

// ─── Severity → Color Mapping (Discord) ─────────────────────────────

const SEVERITY_COLORS: Record<AlertSeverity, number> = {
  info: 0x3498db,     // Blue
  warning: 0xf39c12,  // Orange
  critical: 0xe74c3c, // Red
  error: 0x992d22,    // Dark Red
}

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  info: 'ℹ️',
  warning: '⚠️',
  critical: '🚨',
  error: '❌',
}

// ─── Telegram Formatting ────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function formatTelegramMessage(alert: Alert): string {
  const emoji = SEVERITY_EMOJI[alert.severity]
  const lines = [
    `${emoji} <b>${escHtml(alert.title)}</b>`,
    '',
    escHtml(alert.message),
    '',
    `<i>Type:</i> ${alert.type}`,
    `<i>Severity:</i> ${alert.severity.toUpperCase()}`,
    `<i>Time:</i> ${new Date(alert.timestamp).toUTCString()}`,
  ]

  if (alert.metadata) {
    const metaLines = Object.entries(alert.metadata)
      .map(([k, v]) => `<i>${escHtml(k)}:</i> ${escHtml(String(v))}`)
    lines.push('', ...metaLines)
  }

  return lines.join('\n')
}

// ─── Discord Formatting ─────────────────────────────────────────────

function buildDiscordPayload(alert: Alert): DiscordWebhookPayload {
  const embed: DiscordEmbed = {
    title: `${SEVERITY_EMOJI[alert.severity]} ${alert.title}`,
    description: alert.message,
    color: SEVERITY_COLORS[alert.severity],
    fields: [
      { name: 'Type', value: alert.type, inline: true },
      { name: 'Severity', value: alert.severity.toUpperCase(), inline: true },
    ],
    timestamp: new Date(alert.timestamp).toISOString(),
    footer: { text: 'DeFi Governance Bot' },
  }

  if (alert.metadata) {
    for (const [key, value] of Object.entries(alert.metadata)) {
      embed.fields!.push({
        name: key,
        value: String(value),
        inline: true,
      })
    }
  }

  return {
    embeds: [embed],
    username: 'Gov Alpha Bot',
  }
}

// ─── Dispatch Functions ─────────────────────────────────────────────

async function sendToTelegram(alert: Alert): Promise<void> {
  if (!telegram.isConfigured()) {
    log.debug('Telegram not configured — skipping')
    return
  }

  try {
    const message = formatTelegramMessage(alert)
    await telegram.sendMessage(telegram.getDefaultChatId(), message, 'HTML')
    log.debug({ alertId: alert.id }, 'Telegram alert sent')
  } catch (err) {
    log.error({ err, alertId: alert.id }, 'Failed to send Telegram alert')
  }
}

async function sendToDiscord(alert: Alert): Promise<void> {
  if (!config.discordWebhookUrl) {
    log.debug('Discord webhook not configured — skipping')
    return
  }

  try {
    const payload = buildDiscordPayload(alert)

    await withRetry(
      async () => {
        const res = await fetch(config.discordWebhookUrl!, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })

        if (!res.ok) {
          const text = await res.text()
          throw new Error(`Discord webhook ${res.status}: ${text}`)
        }
      },
      'discord-webhook',
      { maxRetries: 2, baseDelayMs: 2000 },
    )

    log.debug({ alertId: alert.id }, 'Discord alert sent')
  } catch (err) {
    log.error({ err, alertId: alert.id }, 'Failed to send Discord alert')
  }
}

// ─── Deduplication ──────────────────────────────────────────────────

// Track recent alerts to avoid spam (proposalId -> last alert timestamp)
const recentAlerts = new Map<string, number>()
const DEDUP_WINDOW_MS = 3600_000 // 1 hour

/**
 * Check if we should suppress this alert due to recent duplicate.
 * Returns true if alert should be sent, false if it's a duplicate.
 */
function shouldSendAlert(alert: Alert): boolean {
  // Only deduplicate proposal-related alerts
  if (alert.type !== 'proposal_detected') return true
  
  const proposalId = alert.metadata?.proposalId as string | undefined
  if (!proposalId) return true

  const lastSent = recentAlerts.get(proposalId)
  const now = Date.now()

  if (lastSent && (now - lastSent) < DEDUP_WINDOW_MS) {
    log.debug({ proposalId, lastSent: new Date(lastSent).toISOString() }, 'Alert suppressed: duplicate within dedup window')
    return false
  }

  recentAlerts.set(proposalId, now)
  
  // Cleanup old entries periodically
  if (recentAlerts.size > 100) {
    for (const [key, timestamp] of recentAlerts) {
      if (now - timestamp > DEDUP_WINDOW_MS * 2) {
        recentAlerts.delete(key)
      }
    }
  }

  return true
}

// ─── Main Dispatch ──────────────────────────────────────────────────

async function dispatchAlert(alert: Alert): Promise<void> {
  // Check deduplication
  if (!shouldSendAlert(alert)) {
    // Still log to database for record-keeping
    try {
      logAlert({
        type: alert.type,
        severity: alert.severity,
        channel: alert.channel,
        title: `[DEDUPED] ${alert.title}`,
        message: alert.message,
        metadata: alert.metadata,
      })
    } catch (err) {
      log.error({ err, alertId: alert.id }, 'Failed to log deduped alert to database')
    }
    return
  }

  // Log to database
  try {
    logAlert({
      type: alert.type,
      severity: alert.severity,
      channel: alert.channel,
      title: alert.title,
      message: alert.message,
      metadata: alert.metadata,
    })
  } catch (err) {
    log.error({ err, alertId: alert.id }, 'Failed to log alert to database')
  }

  // Dispatch to configured channels
  const promises: Promise<void>[] = []

  if (alert.channel === 'telegram' || alert.channel === 'both') {
    promises.push(sendToTelegram(alert))
  }

  if (alert.channel === 'discord' || alert.channel === 'both') {
    promises.push(sendToDiscord(alert))
  }

  await Promise.allSettled(promises)
}

// ─── Event Bus Integration ──────────────────────────────────────────

export function startAlertService(): void {
  eventBus.on('alert:send', (alert: Alert) => {
    dispatchAlert(alert).catch((err) =>
      log.error({ err, alertId: alert.id }, 'Alert dispatch error'),
    )
  })

  log.info('Alert service started')
}

/**
 * Convenience: send an alert directly (bypasses event bus).
 */
export async function sendAlert(
  type: Alert['type'],
  severity: AlertSeverity,
  title: string,
  message: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const alert: Alert = {
    id: `${type}-${Date.now()}`,
    type,
    severity,
    channel: severity === 'critical' || severity === 'error' ? 'both' : 'telegram',
    title,
    message,
    metadata,
    timestamp: Date.now(),
  }

  await dispatchAlert(alert)
}
