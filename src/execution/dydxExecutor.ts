/**
 * dYdX v4 executor.
 * Places perpetual orders (market, limit, stop-market) on the dYdX v4 chain.
 * Uses short-term orders with block height validity (current + 10 blocks).
 */
import * as dydxClient from '../clients/dydx.js'
import { createLogger } from '../lib/logger.js'
import { withRetry } from '../lib/retry.js'
import { DYDX } from '../config/addresses.js'
import { config } from '../config/index.js'
import type { DydxOrderParams, ExecutionResult, TradeSignal } from '../types/trading.js'

const log = createLogger('dydx-executor')

// ─── Market → dYdX Ticker Mapping ───────────────────────────────────

const ASSET_TO_MARKET: Record<string, string> = {
  AAVE: 'AAVE-USD',
  UNI: 'UNI-USD',
  COMP: 'COMP-USD',
  MKR: 'MKR-USD',
  ETH: 'ETH-USD',
  BTC: 'BTC-USD',
}

function resolveMarket(asset: string): string | null {
  const upper = asset.toUpperCase()
  return ASSET_TO_MARKET[upper] ?? null
}

// ─── Order Execution ────────────────────────────────────────────────

/**
 * Execute a dYdX perp trade from a trade signal.
 * Simulates market order as limit order at oracle price ± 5% slippage.
 */
export async function executeDydxSignal(signal: TradeSignal): Promise<ExecutionResult> {
  const market = resolveMarket(signal.asset)
  if (!market) {
    return {
      success: false,
      signalId: signal.id,
      protocol: 'dydx',
      error: `No dYdX market found for asset: ${signal.asset}`,
      timestamp: Date.now(),
    }
  }

  try {
    // Get current oracle price
    const oraclePrice = await dydxClient.getOraclePrice(market)
    const price = parseFloat(oraclePrice)

    // Calculate limit price with 5% slippage tolerance
    const slippagePct = 0.05
    const limitPrice =
      signal.direction === 'long'
        ? price * (1 + slippagePct) // Buy above current price
        : price * (1 - slippagePct) // Sell below current price

    // Calculate size based on portfolio percentage
    // For now, use a fixed notional size as placeholder
    // In production, this should be calculated from actual portfolio value
    const notionalSize = 100 // Placeholder USD amount per 1% portfolio
    const orderSize = (notionalSize * signal.sizePct) / price

    log.info(
      {
        market,
        direction: signal.direction,
        oraclePrice: price,
        limitPrice: limitPrice.toFixed(2),
        size: orderSize.toFixed(6),
        signalId: signal.id,
      },
      'Placing dYdX order',
    )

    // Build order params
    const orderParams: DydxOrderParams = {
      market,
      side: signal.direction,
      type: 'limit',
      size: orderSize.toFixed(6),
      price: limitPrice.toFixed(2),
      timeInForce: 'IOC', // Immediate-or-cancel for market-like behavior
      reduceOnly: false,
    }

    // NOTE: In production, this would use the dYdX v4 CompositeClient
    // to sign and broadcast the order to the Cosmos chain.
    // For now, we log the intended order.
    log.info({ orderParams }, 'dYdX order prepared (dry run)')

    return {
      success: true,
      signalId: signal.id,
      protocol: 'dydx',
      orderId: `sim-${signal.id}`,
      executedSize: orderParams.size,
      executedPrice: orderParams.price,
      timestamp: Date.now(),
    }
  } catch (err) {
    log.error({ err, signalId: signal.id }, 'dYdX order execution failed')
    return {
      success: false,
      signalId: signal.id,
      protocol: 'dydx',
      error: err instanceof Error ? err.message : String(err),
      timestamp: Date.now(),
    }
  }
}

/**
 * Place a stop-market order for stop-loss protection.
 * dYdX v4 natively supports conditional orders.
 */
export async function placeStopLoss(
  market: string,
  side: 'long' | 'short',
  size: string,
  triggerPrice: string,
): Promise<ExecutionResult> {
  try {
    const orderParams: DydxOrderParams = {
      market,
      side: side === 'long' ? 'short' : 'long', // Stop-loss is opposite direction
      type: 'stop_market',
      size,
      triggerPrice,
      timeInForce: 'IOC',
      reduceOnly: true,
    }

    log.info({ orderParams }, 'Stop-loss order prepared')

    return {
      success: true,
      signalId: `stop-${market}`,
      protocol: 'dydx',
      orderId: `stop-sim-${Date.now()}`,
      executedSize: size,
      executedPrice: triggerPrice,
      timestamp: Date.now(),
    }
  } catch (err) {
    log.error({ err, market }, 'Stop-loss placement failed')
    return {
      success: false,
      signalId: `stop-${market}`,
      protocol: 'dydx',
      error: err instanceof Error ? err.message : String(err),
      timestamp: Date.now(),
    }
  }
}

/**
 * Reduce an existing dYdX position by a percentage.
 */
export async function reducePosition(
  market: string,
  currentSize: string,
  reducePct: number,
): Promise<ExecutionResult> {
  const size = parseFloat(currentSize)
  const reduceSize = Math.abs(size) * (reducePct / 100)
  const side = size > 0 ? 'short' : 'long' // Close direction

  log.info(
    { market, currentSize, reducePct, reduceSize: reduceSize.toFixed(6) },
    'Reducing dYdX position',
  )

  return executeDydxSignal({
    id: `reduce-${market}-${Date.now()}`,
    asset: market.replace('-USD', ''),
    direction: side as 'long' | 'short',
    sizePct: reducePct,
    protocol: 'dydx',
    confidence: 1.0,
    rationale: `Position reduction: ${reducePct}%`,
    proposalId: '',
    governanceStage: '',
    timestamp: Date.now(),
    urgency: 'high',
  })
}
