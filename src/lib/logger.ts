/**
 * Structured logger using pino.
 * Creates child loggers per module for context-aware logging.
 */
import pino from 'pino'
import { config } from '../config/index.js'

const transport =
  process.env.NODE_ENV !== 'production'
    ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
      }
    : undefined

export const logger = pino({
  level: config.logLevel,
  transport,
  base: { service: 'defi-gov-bot' },
  timestamp: pino.stdTimeFunctions.isoTime,
})

/**
 * Create a child logger scoped to a specific module.
 */
export function createLogger(module: string): pino.Logger {
  return logger.child({ module })
}
