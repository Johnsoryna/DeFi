/**
 * Trading types — signals, positions, and orders.
 *
 * All trading goes through Binance USDT-M perpetual futures.
 */

// ─── Trade Signals ──────────────────────────────────────────────────

export type ExecutionProtocol = 'binance'

export type OrderSide = 'long' | 'short'

export type OrderType = 'market' | 'limit' | 'stop_market' | 'stop_limit'

export interface TradeSignal {
  id: string
  asset: string
  direction: OrderSide
  sizePct: number // % of portfolio (notional before leverage)
  protocol: ExecutionProtocol
  confidence: number // 0-1
  rationale: string
  proposalId: string
  governanceStage: string
  timestamp: number
  urgency: 'low' | 'medium' | 'high'

  // ─── Leverage & Risk (optional — backward compatible) ────────
  /** Leverage multiplier (1x = no leverage). Binance supports up to 125x (we cap at 10-20x). */
  leverage?: number
  /** Stop-loss as fraction of entry price (e.g. 0.05 = 5% below entry for long). */
  stopLossPct?: number
  /** Take-profit as fraction of entry price (e.g. 0.10 = 10% above entry for long). */
  takeProfitPct?: number
  /** Trailing stop: activation threshold as fraction (e.g. 0.05 = activate after 5% profit). */
  trailingStopActivation?: number
  /** Trailing stop: distance from peak as fraction (e.g. 0.02 = close if drops 2% from peak). */
  trailingStopDistance?: number
  /** Maximum holding period in hours. Auto-close after this time. */
  maxHoldingHours?: number
}

// ─── Positions ──────────────────────────────────────────────────────

export type PositionProtocol = 'binance' | 'aave'

export type PositionType =
  | 'perp'
  | 'lending_supply'
  | 'lending_borrow'

export interface Position {
  id: string
  protocol: PositionProtocol
  type: PositionType
  asset: string
  size: string              // BigNumber string, signed (negative = short)
  entryPrice: string
  currentPrice: string
  unrealizedPnl: string
  realizedPnl: string
  accruedYield: string
  leverage?: number         // Leverage multiplier (1 = no leverage, >1 = leveraged)
  healthFactor?: number     // Aave only
  lastUpdated: string       // ISO timestamp
}

// ─── Portfolio ──────────────────────────────────────────────────────

export interface Portfolio {
  positions: Position[]
  totalValue: string
  totalUnrealizedPnl: string
  totalRealizedPnl: string
  totalAccruedYield: string
  lastUpdated: string
}

// ─── Order Parameters ───────────────────────────────────────────────

export type BinanceOrderType = 'LIMIT' | 'MARKET' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET' | 'STOP' | 'TAKE_PROFIT'

export type BinanceSide = 'BUY' | 'SELL'

export type BinancePositionSide = 'LONG' | 'SHORT' | 'BOTH'

export type BinanceTimeInForce = 'GTC' | 'IOC' | 'FOK' | 'GTX'

export interface BinanceOrderParams {
  symbol: string               // e.g. 'AAVEUSDT'
  side: BinanceSide
  positionSide?: BinancePositionSide
  type: BinanceOrderType
  quantity?: string
  price?: string               // For LIMIT orders
  stopPrice?: string           // For STOP_MARKET / TAKE_PROFIT_MARKET
  timeInForce?: BinanceTimeInForce
  reduceOnly?: boolean
  closePosition?: boolean
  newClientOrderId?: string
}

// ─── Execution Results ──────────────────────────────────────────────

export interface ExecutionResult {
  success: boolean
  /** True when asset has no Binance Futures perp — not an error, just not executable live */
  skipped?: boolean
  signalId: string
  protocol: ExecutionProtocol | string
  orderId?: string
  transactionHash?: string
  executedSize?: string
  executedPrice?: string
  error?: string
  timestamp: number
  metadata?: {
    gasCostUsd?: number
    slippagePct?: number
    basePrice?: number
    [key: string]: unknown
  }
}
