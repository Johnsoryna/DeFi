/**
 * Exponential backoff retry utility for network calls.
 */
import { createLogger } from './logger.js'

const log = createLogger('retry')

export interface RetryOptions {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  /** Optional: only retry on specific error conditions */
  shouldRetry?: (error: unknown) => boolean
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
}

/**
 * Execute an async function with exponential backoff retries.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  opts: Partial<RetryOptions> = {},
): Promise<T> {
  const options = { ...DEFAULT_OPTIONS, ...opts }
  let lastError: unknown

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error

      if (options.shouldRetry && !options.shouldRetry(error)) {
        throw error
      }

      if (attempt === options.maxRetries) {
        log.error({ err: error, label, attempt }, 'All retries exhausted')
        throw error
      }

      const delay = Math.min(
        options.baseDelayMs * Math.pow(2, attempt) + Math.random() * 500,
        options.maxDelayMs,
      )

      log.warn(
        { label, attempt: attempt + 1, maxRetries: options.maxRetries, delayMs: Math.round(delay) },
        'Retrying after error',
      )

      await sleep(delay)
    }
  }

  throw lastError
}

/**
 * Rate-limited function wrapper — ensures minimum interval between calls.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function rateLimited<T extends (...args: any[]) => Promise<unknown>>(
  fn: T,
  minIntervalMs: number,
): T {
  let lastCall = 0

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (async (...args: any[]) => {
    const now = Date.now()
    const elapsed = now - lastCall
    if (elapsed < minIntervalMs) {
      await sleep(minIntervalMs - elapsed)
    }
    lastCall = Date.now()
    return fn(...args)
  }) as T
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export { sleep }
