/**
 * Trading types — signals, positions, and orders.
 */

// ─── Trade Signals ──────────────────────────────────────────────────

export type ExecutionProtocol = 'dydx' | 'pendle' | 'spot'

export type OrderSide = 'long' | 'short'

export type OrderType = 'market' | 'limit' | 'stop_market' | 'stop_limit'

export interface TradeSignal {
  id: string
  asset: string
  direction: OrderSide
  sizePct: number // % of portfolio
  protocol: ExecutionProtocol
  confidence: number // 0-1
  rationale: string
  proposalId: string
  governanceStage: string
  timestamp: number
  urgency: 'low' | 'medium' | 'high'
}

// ─── Positions ──────────────────────────────────────────────────────

export type PositionProtocol = 'dydx' | 'aave' | 'pendle' | 'spot'

export type PositionType =
  | 'perp'
  | 'lending_supply'
  | 'lending_borrow'
  | 'yield_pt'
  | 'yield_yt'
  | 'spot'

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
  healthFactor?: number     // Aave only
  maturity?: string         // Pendle only (ISO timestamp)
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

export interface DydxOrderParams {
  market: string         // e.g. 'AAVE-USD'
  side: OrderSide
  type: OrderType
  size: string
  price?: string         // For limit/stop orders
  triggerPrice?: string  // For stop orders
  timeInForce: 'GTT' | 'IOC' | 'FOK'
  goodTilBlock?: number
  postOnly?: boolean
  reduceOnly?: boolean
}

export interface PendleSwapParams {
  chainId: number
  marketAddress: string
  tokenIn: string
  tokenOut: string // PT or YT address
  amountIn: string
  slippage: number // e.g. 0.01 = 1%
  receiver: string
}

export interface DexSwapParams {
  tokenIn: string
  tokenOut: string
  amountIn: string
  slippage: number
  receiver: string
  deadline?: number
  preferredRouter: 'cowswap' | 'uniswap'
}

// ─── Execution Results ──────────────────────────────────────────────

export interface ExecutionResult {
  success: boolean
  signalId: string
  protocol: ExecutionProtocol
  orderId?: string
  transactionHash?: string
  executedSize?: string
  executedPrice?: string
  error?: string
  timestamp: number
}
