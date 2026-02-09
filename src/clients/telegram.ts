/**
 * Telegram Bot API client.
 * 100% free. Rate limits: ~1 msg/sec/chat, ~30 msg/sec globally.
 */
import { createLogger } from '../lib/logger.js'
import { withRetry, rateLimited } from '../lib/retry.js'
import { config } from '../config/index.js'

const log = createLogger('telegram')

const API_BASE = config.telegramBotToken
  ? `https://api.telegram.org/bot${config.telegramBotToken}`
  : null

// Rate limit: 1 message per second per chat
const sendRateLimited = rateLimited(
  async (endpoint: string, body: Record<string, unknown>): Promise<any> => {
    if (!API_BASE) {
      log.warn('Telegram bot token not configured — message not sent')
      return null
    }

    return withRetry(
      async () => {
        const res = await fetch(`${API_BASE}/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })

        if (!res.ok) {
          const text = await res.text()
          throw new Error(`Telegram API ${res.status}: ${text}`)
        }

        return res.json()
      },
      `telegram-${endpoint}`,
      { maxRetries: 2, baseDelayMs: 2000 },
    )
  },
  1100,
)

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Send a text message to a Telegram chat.
 */
export async function sendMessage(
  chatId: string,
  text: string,
  parseMode: 'HTML' | 'MarkdownV2' = 'HTML',
): Promise<void> {
  await sendRateLimited('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: true,
  })
  log.debug({ chatId }, 'Telegram message sent')
}

/**
 * Send a photo with caption.
 */
export async function sendPhoto(
  chatId: string,
  photoUrl: string,
  caption?: string,
): Promise<void> {
  await sendRateLimited('sendPhoto', {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    parse_mode: 'HTML',
  })
}

/**
 * Check if Telegram is configured.
 */
export function isConfigured(): boolean {
  return !!config.telegramBotToken && !!config.telegramChatId
}

/**
 * Get the default chat ID from config.
 */
export function getDefaultChatId(): string {
  if (!config.telegramChatId) throw new Error('TELEGRAM_CHAT_ID not configured')
  return config.telegramChatId
}
