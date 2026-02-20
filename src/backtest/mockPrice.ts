/**
 * Mock price monitor for backtesting.
 * Serves cached historical prices from the backtest database.
 * Guarantees no look-ahead: only returns prices at or before the requested timestamp.
 *
 * Uses the assetResolver to map contract addresses and ilk names
 * to price symbols so that lookups always succeed.
 */
import type Database from 'better-sqlite3'
import { createLogger } from '../lib/logger.js'
import { resolveAssetSymbol } from './assetResolver.js'
import type { Clock } from './clock.js'

const _log = createLogger('mock-price')

export class MockPriceMonitor {
  constructor(
    private db: Database.Database,
    private clock: Clock,
  ) {}

  /**
   * Get the price of an asset at the given timestamp (or current clock time).
   * Accepts contract addresses, ilk names, or symbols — all resolved automatically.
   * Returns the most recent price at or before the timestamp (no look-ahead).
   */
  getPrice(asset: string, timestamp?: number): string | null {
    const ts = timestamp ?? this.clock.now()
    const symbol = resolveAssetSymbol(asset)

    const row = this.db.prepare(
      `SELECT price FROM historical_prices
       WHERE asset = ? AND timestamp <= ?
       ORDER BY timestamp DESC LIMIT 1`,
    ).get(symbol, ts) as { price: string } | undefined

    if (!row) {
      // Also try the raw asset value (uppercased) in case it was stored that way
      const fallback = this.db.prepare(
        `SELECT price FROM historical_prices
         WHERE asset = ? AND timestamp <= ?
         ORDER BY timestamp DESC LIMIT 1`,
      ).get(asset.toUpperCase(), ts) as { price: string } | undefined
      return fallback?.price ?? null
    }

    return row.price
  }

  /**
   * Get recent prices for an asset (no look-ahead).
   * Returns prices from [timestamp - lookbackMs, timestamp] sorted ascending.
   */
  getRecentPrices(asset: string, timestamp: number, lookbackMs: number): Array<{ price: number; timestamp: number }> {
    const symbol = resolveAssetSymbol(asset)
    const fromTs = timestamp - lookbackMs
    const rows = this.db.prepare(
      `SELECT CAST(price AS REAL) as price, timestamp
       FROM historical_prices
       WHERE asset = ? AND timestamp >= ? AND timestamp <= ?
       ORDER BY timestamp ASC`,
    ).all(symbol, fromTs, timestamp) as Array<{ price: number; timestamp: number }>
    return rows
  }

  /**
   * Calculate ATR-like volatility for an asset (no look-ahead).
   * Uses average absolute daily returns over the lookback period.
   * Returns a fraction (e.g., 0.05 = 5% daily volatility).
   */
  getVolatility(asset: string, timestamp: number, lookbackDays: number = 14): number {
    const lookbackMs = lookbackDays * 24 * 3600_000
    const prices = this.getRecentPrices(asset, timestamp, lookbackMs)
    if (prices.length < 48) return 0 // Need at least 2 days of hourly data

    // Compute daily returns (every 24 hours)
    const dailyReturns: number[] = []
    const hoursPerDay = 24
    for (let i = hoursPerDay; i < prices.length; i += hoursPerDay) {
      const prevPrice = prices[i - hoursPerDay].price
      const curPrice = prices[i].price
      if (prevPrice > 0) {
        dailyReturns.push(Math.abs((curPrice - prevPrice) / prevPrice))
      }
    }

    if (dailyReturns.length === 0) return 0

    // ATR = average absolute daily return
    const atr = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length
    return atr
  }

  /**
   * Get the price trend for an asset (no look-ahead).
   * Returns: +1 if price is above N-day SMA (uptrend), -1 if below (downtrend), 0 if unknown.
   */
  getTrend(asset: string, timestamp: number, lookbackDays: number = 14): number {
    const prices = this.getRecentPrices(asset, timestamp, lookbackDays * 24 * 3600_000)
    if (prices.length < 48) return 0

    const allPrices = prices.map(p => p.price)
    const sma = allPrices.reduce((a, b) => a + b, 0) / allPrices.length
    const currentPrice = allPrices[allPrices.length - 1]

    return currentPrice > sma ? 1 : -1
  }

  /**
   * Get the highest price of an asset in the lookback period (no look-ahead).
   */
  getHighPrice(asset: string, timestamp: number, lookbackDays: number): number {
    const symbol = resolveAssetSymbol(asset)
    const fromTs = timestamp - lookbackDays * 24 * 3600_000
    const row = this.db.prepare(
      `SELECT MAX(CAST(price AS REAL)) as high
       FROM historical_prices
       WHERE asset = ? AND timestamp >= ? AND timestamp <= ?`,
    ).get(symbol, fromTs, timestamp) as { high: number | null } | undefined
    return row?.high ?? 0
  }

  /**
   * Get prices for all tracked assets at the current clock time.
   */
  getAllPrices(): Map<string, string> {
    const ts = this.clock.now()
    const assets = this.db.prepare(
      `SELECT DISTINCT asset FROM historical_prices`,
    ).all() as { asset: string }[]
    const prices = new Map<string, string>()

    for (const { asset } of assets) {
      const price = this.getPrice(asset, ts)
      if (price) prices.set(asset, price)
    }

    return prices
  }

  /**
   * Get interpolated price between two data points for more accuracy.
   * Falls back to nearest-before if interpolation is not possible.
   * 
   * WARNING: This method uses future prices for interpolation, which violates
   * the no look-ahead rule. Use getPrice() for strict backtesting.
   * This method is provided for analysis/visualization purposes only.
   */
  getInterpolatedPrice(asset: string, timestamp?: number): string | null {
    const ts = timestamp ?? this.clock.now()
    const symbol = resolveAssetSymbol(asset)

    // Get the price at or before ts
    const before = this.db.prepare(
      `SELECT price, timestamp FROM historical_prices
       WHERE asset = ? AND timestamp <= ?
       ORDER BY timestamp DESC LIMIT 1`,
    ).get(symbol, ts) as { price: string; timestamp: number } | undefined

    if (!before) return null

    // Get the next price after ts
    const after = this.db.prepare(
      `SELECT price, timestamp FROM historical_prices
       WHERE asset = ? AND timestamp > ?
       ORDER BY timestamp ASC LIMIT 1`,
    ).get(symbol, ts) as { price: string; timestamp: number } | undefined

    // If no future price or same timestamp, return the before price
    if (!after || after.timestamp === before.timestamp) return before.price

    // Linear interpolation
    const priceBefore = parseFloat(before.price)
    const priceAfter = parseFloat(after.price)
    const timeFraction = (ts - before.timestamp) / (after.timestamp - before.timestamp)
    const interpolated = priceBefore + (priceAfter - priceBefore) * timeFraction

    return interpolated.toString()
  }

  /**
   * Get the number of price data points available for an asset.
   */
  getDataPointCount(asset: string): number {
    const symbol = resolveAssetSymbol(asset)
    const row = this.db.prepare(
      `SELECT COUNT(*) as count FROM historical_prices WHERE asset = ?`,
    ).get(symbol) as { count: number }
    return row.count
  }
}
