/**
 * Global price service for cross-module price access.
 *
 * During backtesting, the MockPriceMonitor is injected as the price service.
 * During live trading, the real price monitor is injected.
 *
 * This allows the signal generator and other modules to access prices
 * without tight coupling to the backtest or live infrastructure.
 */

export interface PriceService {
  /** Get price at or before the given timestamp (no look-ahead) */
  getPrice(asset: string, timestamp?: number): string | null

  /** Get volatility (ATR-like) as a fraction (e.g., 0.05 = 5% daily) */
  getVolatility?(asset: string, timestamp: number, lookbackDays?: number): number

  /** Get trend: +1 uptrend, -1 downtrend, 0 unknown */
  getTrend?(asset: string, timestamp: number, lookbackDays?: number): number

  /** Get the highest price in the lookback period (no look-ahead) */
  getHighPrice?(asset: string, timestamp: number, lookbackDays: number): number
}

let _priceService: PriceService | null = null

export function setPriceService(svc: PriceService | null): void {
  _priceService = svc
}

export function getPriceService(): PriceService | null {
  return _priceService
}

/**
 * Check if ETH is in a macro uptrend.
 * Returns:
 *   'bull' — ETH above 14-day SMA
 *   'bear' — ETH below 14-day SMA
 *   'unknown' — no price data available
 */
export function getMarketRegime(timestamp: number): 'bull' | 'bear' | 'unknown' {
  if (!_priceService?.getTrend) return 'unknown'

  // Try WETH first (how ETH is stored in most DeFi price feeds)
  let ethTrend = _priceService.getTrend('WETH', timestamp, 14)
  if (ethTrend === 0) {
    ethTrend = _priceService.getTrend('ETH', timestamp, 14)
  }
  if (ethTrend > 0) return 'bull'
  if (ethTrend < 0) return 'bear'
  return 'unknown'
}

/**
 * Check if an asset is oversold (too far below recent highs).
 * Returns the drawdown from 30-day high as a fraction (0 = at highs, 0.5 = 50% below).
 */
export function getDrawdownFromHigh(asset: string, timestamp: number): number {
  if (!_priceService?.getHighPrice || !_priceService?.getPrice) return 0

  const currentPriceStr = _priceService.getPrice(asset, timestamp)
  if (!currentPriceStr) return 0
  const currentPrice = parseFloat(currentPriceStr)
  if (currentPrice <= 0) return 0

  const highPrice = _priceService.getHighPrice(asset, timestamp, 30)
  if (highPrice <= 0) return 0

  return (highPrice - currentPrice) / highPrice
}

/**
 * Check if an asset is in a short-term bounce (price recovering after a drawdown).
 * Returns the 7-day return as a fraction (positive = bouncing up, negative = still falling).
 *
 * The key insight: shorts work while the price is FALLING, but fail when bouncing.
 * - April 2025: AAVE was deeply oversold AND bouncing → shorts lost $9,648
 * - Feb 2025: AAVE was oversold but still falling → shorts won $10,000+
 */
export function getShortTermMomentum(asset: string, timestamp: number): number {
  if (!_priceService?.getPrice) return 0

  const currentStr = _priceService.getPrice(asset, timestamp)
  const weekAgoStr = _priceService.getPrice(asset, timestamp - 7 * 24 * 3600_000)

  if (!currentStr || !weekAgoStr) return 0

  const current = parseFloat(currentStr)
  const weekAgo = parseFloat(weekAgoStr)

  if (weekAgo <= 0) return 0
  return (current - weekAgo) / weekAgo
}

// ─── A3: Configurable Momentum Check ─────────────────────────────────

/**
 * Get price momentum for an asset over a configurable lookback period.
 * Returns the fractional price change (e.g., 0.05 = +5%).
 * Returns null when price data is unavailable (caller decides fail-open/closed).
 */
export function getMomentum(asset: string, timestamp: number, lookbackDays: number): number | null {
  if (!_priceService?.getPrice) return null

  const currentStr = _priceService.getPrice(asset, timestamp)
  const pastStr = _priceService.getPrice(asset, timestamp - lookbackDays * 24 * 3600_000)

  if (!currentStr || !pastStr) return null

  const current = parseFloat(currentStr)
  const past = parseFloat(pastStr)

  if (past <= 0 || !Number.isFinite(current)) return null
  return (current - past) / past
}

// ─── B2: V-Reversal Detection ────────────────────────────────────────

/**
 * Detect if ETH is in a V-reversal pattern (crash + fast recovery).
 *
 * A V-reversal occurs when:
 *   - ETH dropped >10% in the first week (T-14d to T-7d)
 *   - ETH recovered >8% in the second week (T-7d to T)
 *
 * During V-reversals, short-selling is contra-productive because:
 *   - Short momentum is exhausted after the crash
 *   - Buyers are stepping in during the recovery phase
 *   - New shorts get squeezed by the recovering price
 *
 * Returns true if V-reversal detected, false if not, false if no data (fail-open).
 */
export function hasEthVReversal(timestamp: number): boolean {
  if (!_priceService?.getPrice) return false // fail-open: no data → allow trades

  // Get ETH prices at T, T-7d, T-14d (try WETH first, then ETH)
  let nowStr = _priceService.getPrice('WETH', timestamp)
  let d7Str = _priceService.getPrice('WETH', timestamp - 7 * 24 * 3600_000)
  let d14Str = _priceService.getPrice('WETH', timestamp - 14 * 24 * 3600_000)

  if (!nowStr || !d7Str || !d14Str) {
    // Fallback to 'ETH' symbol
    nowStr = _priceService.getPrice('ETH', timestamp)
    d7Str = _priceService.getPrice('ETH', timestamp - 7 * 24 * 3600_000)
    d14Str = _priceService.getPrice('ETH', timestamp - 14 * 24 * 3600_000)
  }

  if (!nowStr || !d7Str || !d14Str) return false // fail-open

  const now = parseFloat(nowStr)
  const d7 = parseFloat(d7Str)
  const d14 = parseFloat(d14Str)

  if (d14 <= 0 || d7 <= 0) return false

  const firstWeekChange = (d7 - d14) / d14   // negative = drop
  const secondWeekChange = (now - d7) / d7    // positive = recovery

  // V-reversal: >10% crash followed by >8% bounce
  return firstWeekChange < -0.10 && secondWeekChange > 0.08
}
