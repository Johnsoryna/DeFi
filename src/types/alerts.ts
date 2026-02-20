/**
 * Alert types — notifications dispatched to Telegram / Discord.
 */

export type AlertSeverity = 'info' | 'warning' | 'critical' | 'error'

export type AlertChannel = 'telegram' | 'discord' | 'both'

export type AlertType =
  | 'proposal_detected'
  | 'vote_threshold_crossed'
  | 'stage_transition'
  | 'trade_executed'
  | 'stop_loss_triggered'
  | 'trade_exit'
  | 'health_warning'
  | 'whale_movement'
  | 'system_error'
  | 'system_health'

export interface Alert {
  id: string
  type: AlertType
  severity: AlertSeverity
  channel: AlertChannel
  title: string
  message: string
  metadata?: Record<string, unknown>
  timestamp: number
}

export interface TelegramMessage {
  chatId: string
  text: string
  parseMode: 'HTML' | 'MarkdownV2'
}

export interface DiscordEmbed {
  title: string
  description: string
  color: number // Decimal color code
  fields?: Array<{ name: string; value: string; inline?: boolean }>
  timestamp?: string
  footer?: { text: string }
}

export interface DiscordWebhookPayload {
  content?: string
  embeds?: DiscordEmbed[]
  username?: string
  avatar_url?: string
}
