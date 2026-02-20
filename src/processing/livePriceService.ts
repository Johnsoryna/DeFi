/**
 * LivePriceService — Adapter that bridges the live PriceMonitor to the PriceService interface.
 *
 * The backtest uses MockPriceMonitor with full historical DB access (getPrice with timestamp).
 * Live trading uses priceMonitor.getPrice() which only returns the CURRENT price.
 *
 * This adapter solves the gap by:
 *   1. Maintaining a rolling 14-day historical price cache in memory
 *   2. Updating the cache every time a price:update event fires
 *   3. Implementing the full PriceService interface (getPrice, getVolatility, getTrend, getHighPrice)
 *
 * This ensures A3 (Momentum-Confirmation) and B2 (V-Reversal) filters work identically
 * in live trading as they do in backtesting.
 */
import { getPrice as getLivePrice } from './priceMonitor.js'
import { eventBus } from '../lib/eventBus.js'
import { createLogger } from '../lib/logger.js'
import type { PriceService } from '../strategy/priceService.js'

const log = createLogger('live-price-svc')

// ─── Historical Price Cache ─────────────────────────────────────────

interface PricePoint {
  price: number
  timestamp: number
}

/** Rolling cache: asset → sorted array of {price, timestamp} */
const priceHistory = new Map<string, PricePoint[]>()

/** How much history to keep (14 days in ms — enough for V-Reversal's 14d lookback) */
const MAX_HISTORY_MS = 14 * 24 * 3600_000

/** Minimum interval between cached points (1 hour — avoids memory bloat) */
const MIN_INTERVAL_MS = 3600_000

/**
 * Record a price observation into the history cache.
 * Called on every price:update event.
 */
function recordPrice(asset: string, price: number, timestamp: number): void {
  const key = asset.toUpperCase()
  let history = priceHistory.get(key)
  if (!history) {
    history = []
    priceHistory.set(key, history)
  }

  // Only add if enough time has passed since last point (avoid bloat)
  const last = history[history.length - 1]
  if (last && (timestamp - last.timestamp) < MIN_INTERVAL_MS) {
    // Update the latest point instead of adding a new one
    last.price = price
    last.timestamp = timestamp
    return
  }

  history.push({ price, timestamp })

  // Evict old entries beyond the retention window
  const cutoff = timestamp - MAX_HISTORY_MS
  while (history.length > 0 && history[0].timestamp < cutoff) {
    history.shift()
  }
}

// ─── PriceService Implementation ────────────────────────────────────

class LivePriceServiceImpl implements PriceService {
  /**
   * Get price at or before the given timestamp.
   * - If no timestamp (or timestamp ≈ now): return live price
   * - If historical timestamp: search the cache
   */
  getPrice(asset: string, timestamp?: number): string | null {
    const key = asset.toUpperCase()

    // No timestamp or very recent → return live price
    if (!timestamp || Math.abs(Date.now() - timestamp) < MIN_INTERVAL_MS) {
      return getLivePrice(key)
    }

    // Historical lookup from cache
    const history = priceHistory.get(key)
    if (!history || history.length === 0) return null

    // Binary search for the latest point at or before timestamp
    let lo = 0, hi = history.length - 1, best: PricePoint | null = null
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      if (history[mid].timestamp <= timestamp) {
        best = history[mid]
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }

    return best ? best.price.toString() : null
  }

  /**
   * Calculate ATR-like volatility from cached price history.
   */
  getVolatility(asset: string, timestamp: number, lookbackDays: number = 14): number {
    const key = asset.toUpperCase()
    const history = priceHistory.get(key)
    if (!history || history.length < 24) return 0

    const fromTs = timestamp - lookbackDays * 24 * 3600_000
    const relevant = history.filter(p => p.timestamp >= fromTs && p.timestamp <= timestamp)
    if (relevant.length < 24) return 0

    // Resample to daily close prices by grouping cache points into calendar days.
    // Cache points are ~1h apart — pick the last point of each UTC day.
    const dayMs = 24 * 3600_000
    const dailyClose = new Map<number, number>() // dayIndex → price
    for (const p of relevant) {
      const dayIdx = Math.floor(p.timestamp / dayMs)
      dailyClose.set(dayIdx, p.price) // later point in the day overwrites → close
    }

    // Compute daily absolute returns from consecutive day closes
    const days = [...dailyClose.entries()].sort((a, b) => a[0] - b[0])
    const dailyReturns: number[] = []
    for (let i = 1; i < days.length; i++) {
      const prevPrice = days[i - 1][1]
      if (prevPrice > 0) {
        dailyReturns.push(Math.abs((days[i][1] - prevPrice) / prevPrice))
      }
    }

    if (dailyReturns.length === 0) return 0
    return dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length
  }

  /**
   * Get price trend: +1 if above SMA (uptrend), -1 if below (downtrend), 0 if unknown.
   */
  getTrend(asset: string, timestamp: number, lookbackDays: number = 14): number {
    const key = asset.toUpperCase()
    const history = priceHistory.get(key)
    if (!history || history.length < 10) return 0

    const fromTs = timestamp - lookbackDays * 24 * 3600_000
    const relevant = history.filter(p => p.timestamp >= fromTs && p.timestamp <= timestamp)
    if (relevant.length < 10) return 0

    const prices = relevant.map(p => p.price)
    const sma = prices.reduce((a, b) => a + b, 0) / prices.length
    const current = prices[prices.length - 1]

    return current > sma ? 1 : -1
  }

  /**
   * Get the highest price in the lookback period.
   */
  getHighPrice(asset: string, timestamp: number, lookbackDays: number): number {
    const key = asset.toUpperCase()
    const history = priceHistory.get(key)
    if (!history || history.length === 0) return 0

    const fromTs = timestamp - lookbackDays * 24 * 3600_000
    let maxPrice = 0
    for (const p of history) {
      if (p.timestamp >= fromTs && p.timestamp <= timestamp && p.price > maxPrice) {
        maxPrice = p.price
      }
    }
    return maxPrice
  }
}

// ─── Singleton ──────────────────────────────────────────────────────

const _instance = new LivePriceServiceImpl()

export function getLivePriceService(): PriceService {
  return _instance
}

/**
 * Start recording price history from the event bus.
 * Must be called AFTER startPriceMonitor().
 */
export function startLivePriceHistory(): void {
  eventBus.on('price:update', (event: { asset: string; price: string; source: string }) => {
    const price = parseFloat(event.price)
    if (Number.isFinite(price) && price > 0) {
      recordPrice(event.asset, price, Date.now())
    }
  })

  log.info('Live price history recording started (14-day rolling cache)')
}

/**
 * Get the current cache size for diagnostics.
 */
export function getPriceHistoryStats(): Record<string, number> {
  const stats: Record<string, number> = {}
  priceHistory.forEach((history, asset) => {
    stats[asset] = history.length
  })
  return stats
}
