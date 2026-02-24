/**
 * Binance Futures (USDT-M) executor.
 * Places perpetual orders (market, stop-market, take-profit-market) on Binance.
 *
 * MODES:
 *   DRY_RUN=true  (default) → logs order intent, does NOT send to exchange
 *   DRY_RUN=false           → sends signed orders via Binance REST API
 *
 * Order flow:
 *   1. Resolve symbol (e.g. AAVE → AAVEUSDT)
 *   2. Fetch mark price + account balance (real portfolio value)
 *   3. Set leverage for the symbol
 *   4. Calculate position size = (equity × sizePct/100 × leverage) / price
 *   5. Round to exchange step/tick size
 *   6. Check minimum notional (5 USDT)
 *   7. Place entry order (MARKET)
 *   8. Place stop-loss order (STOP_MARKET, reduce-only)
 *   9. Place take-profit order (TAKE_PROFIT_MARKET, reduce-only)
 */
import * as binanceClient from '../clients/binance.js'
import { createLogger } from '../lib/logger.js'
import { config } from '../config/index.js'
import type { BinanceOrderParams, ExecutionResult, TradeSignal } from '../types/trading.js'

// Binance Futures max callbackRate for TRAILING_STOP_MARKET orders
const TRAILING_STOP_MAX_CALLBACK_RATE = 5.0 // 5% max per Binance Futures limits

const log = createLogger('binance-executor')

// ─── Market → Binance Symbol Mapping ────────────────────────────────

const ASSET_TO_SYMBOL: Record<string, string> = {
  // Core Assets
  ETH: 'ETHUSDT', WETH: 'ETHUSDT',
  BTC: 'BTCUSDT', WBTC: 'BTCUSDT',
  LINK: 'LINKUSDT',
  // Governance Tokens (curated protocols)
  AAVE: 'AAVEUSDT',
  UNI: 'UNIUSDT',
  COMP: 'COMPUSDT',
  MKR: 'MKRUSDT',
  SKY: 'SKYUSDT',
  LDO: 'LDOUSDT',
  ARB: 'ARBUSDT',
  CRV: 'CRVUSDT',
  CVX: 'CVXUSDT',
  YFI: 'YFIUSDT',
  OP: 'OPUSDT',
  DYDX: 'DYDXUSDT',
  ENA: 'ENAUSDT',
  EIGEN: 'EIGENUSDT',
  ENS: 'ENSUSDT',
  // New Protocol Governance Tokens
  GMX: 'GMXUSDT',
  JUP: 'JUPUSDT',
  TIA: 'TIAUSDT',
  AVAX: 'AVAXUSDT',
  POL: 'POLUSDT',
  STRK: 'STRKUSDT',
  SUI: 'SUIUSDT',
  // MNT: REMOVED — no Binance USDT perp (delisted)
  SEI: 'SEIUSDT',
  // Cosmos ecosystem
  ATOM: 'ATOMUSDT',
  INJ: 'INJUSDT',
  AXL: 'AXLUSDT',
  NEAR: 'NEARUSDT',
  APT: 'APTUSDT',
  BLUR: 'BLURUSDT',
  JTO: 'JTOUSDT',
  ZK: 'ZKUSDT',
  DRIFT: 'DRIFTUSDT',
  PYTH: 'PYTHUSDT',
  STX: 'STXUSDT',
  // ─── Gruppe C+D (Feb 2026) ──────────────────────────────────────
  '1INCH': '1INCHUSDT',
  SNX: 'SNXUSDT',
  PENDLE: 'PENDLEUSDT',
  GRT: 'GRTUSDT',
  EUL: 'EULUSDT',    // Euler Finance — EULUSDT active on Binance Futures
  // ─── Removed ────────────────────────────────────────────────────
  // FXS: REMOVED — 0 trades in backtest (re-tested Feb 2026 with body analysis — still 0)
  // BAL: REMOVED — no Binance USDT perp (delisted)
  // MNT: REMOVED — no Binance USDT perp (delisted)
  // XVS: REMOVED — 0 trades in backtest
  // RPL: REMOVED — 0 trades in backtest
}

// Liquidity-tiered slippage multipliers for Binance Futures
// Binance has significantly higher liquidity than dYdX on most tokens
const BINANCE_LIQUIDITY_MULTIPLIER: Record<string, number> = {
  // Tier 1: Extremely liquid ($500M+ 24h vol) — base slippage
  ETH: 1.0, WETH: 1.0, BTC: 1.0, WBTC: 1.0,
  // Tier 2: Very liquid ($50M-500M vol) — 1.2x
  AAVE: 1.2, LINK: 1.2, UNI: 1.2, ARB: 1.2, OP: 1.2,
  SUI: 1.2, AVAX: 1.2, TIA: 1.2, NEAR: 1.2, APT: 1.2,
  ATOM: 1.2, INJ: 1.2,
  // Tier 3: Liquid ($10M-50M vol) — 1.5x
  LDO: 1.5, COMP: 1.5, ENA: 1.5, ENS: 1.5,
  MKR: 1.5, CRV: 1.5, YFI: 1.5,
  SEI: 1.5, DYDX: 1.5, JUP: 1.5, STX: 1.5,
  BLUR: 1.5, JTO: 1.5, PYTH: 1.5,
  // Tier 4: Medium ($1M-10M vol) — 2.0x
  CVX: 2.0,
  SKY: 2.0, EIGEN: 2.0, GMX: 2.0, POL: 2.0,
  STRK: 2.0, ZK: 2.0, DRIFT: 2.0, AXL: 2.0,
  // ─── Gruppe C+D (Feb 2026) ──────────────────────────────────────
  '1INCH': 2.0,   // $5M-15M vol tier
  SNX: 1.5,       // $30M-80M vol — medium liquid derivatives token
  PENDLE: 1.5,    // $15M-40M vol — yield tokenization
  GRT: 2.0,       // $10M-25M vol — indexing protocol
  EUL: 2.5,       // ~$17M vol — smaller DeFi token, higher slippage
  // ─── Removed ────────────────────────────────────────────────────
  // FXS: REMOVED — 0 trades in backtest (re-tested Feb 2026 with body analysis — still 0)
  // BAL: REMOVED — no Binance USDT perp
  // MNT: REMOVED — no Binance USDT perp
  // XVS/RPL: REMOVED — 0 trades in backtest
}

function resolveSymbol(asset: string): string | null {
  return ASSET_TO_SYMBOL[asset.toUpperCase()] ?? null
}

/** Dynamic slippage based on asset liquidity tier */
function getSlippagePct(asset: string): number {
  const multiplier = BINANCE_LIQUIDITY_MULTIPLIER[asset.toUpperCase()] ?? 2.0
  const BASE_SLIPPAGE = 0.0003 // 0.03% base (Binance has deep books)
  return Math.min(BASE_SLIPPAGE * multiplier, 0.02) // Cap at 2%
}

// ─── Cached Portfolio Value ─────────────────────────────────────────

let cachedEquity = 0
let equityCacheTs = 0
const EQUITY_CACHE_TTL = 30_000 // 30s

/**
 * Get portfolio equity from Binance Futures account (with cache).
 * Falls back to config.initialPortfolioUsd if no API keys configured.
 */
async function getPortfolioEquity(): Promise<number> {
  if (Date.now() - equityCacheTs < EQUITY_CACHE_TTL && cachedEquity > 0) {
    return cachedEquity
  }

  if (!config.binanceApiKey || !config.binanceApiSecret) {
    return config.initialPortfolioUsd
  }

  try {
    const account = await binanceClient.getAccountInfo()
    const equity = parseFloat(account.totalMarginBalance)
    if (equity > 0) {
      cachedEquity = equity
      equityCacheTs = Date.now()
      return equity
    }
  } catch (err) {
    log.warn({ err }, 'Failed to fetch Binance account equity — using cached/fallback')
  }

  return cachedEquity > 0 ? cachedEquity : config.initialPortfolioUsd
}

// ─── Exchange Info Cache ────────────────────────────────────────────

let symbolInfoCache: Map<string, { tickSize: string; stepSize: string; minNotional: string }> | null = null

async function getSymbolInfo(symbol: string): Promise<{ tickSize: string; stepSize: string; minNotional: string }> {
  if (!symbolInfoCache) {
    const info = await binanceClient.getExchangeInfo()
    symbolInfoCache = new Map()
    for (const [sym, market] of info) {
      symbolInfoCache.set(sym, {
        tickSize: market.tickSize,
        stepSize: market.stepSize,
        minNotional: market.minNotional,
      })
    }
  }
  return symbolInfoCache.get(symbol) ?? { tickSize: '0.01', stepSize: '0.001', minNotional: '5' }
}

// ─── Order Execution ────────────────────────────────────────────────

/**
 * Execute a Binance Futures trade from a trade signal.
 * Uses real portfolio value and places protective orders after entry.
 */
export async function executeBinanceSignal(signal: TradeSignal): Promise<ExecutionResult> {
  const symbol = resolveSymbol(signal.asset)
  if (!symbol) {
    return {
      success: false,
      signalId: signal.id,
      protocol: 'binance',
      error: `No Binance Futures market found for asset: ${signal.asset}`,
      timestamp: Date.now(),
    }
  }

  try {
    // 1. Get current mark price
    const markPriceStr = await binanceClient.getMarkPrice(symbol)
    const price = parseFloat(markPriceStr)

    if (price <= 0 || !isFinite(price)) {
      return {
        success: false,
        signalId: signal.id,
        protocol: 'binance',
        error: `Invalid mark price for ${symbol}: ${price}`,
        timestamp: Date.now(),
      }
    }

    // 2. Get exchange info for rounding
    const info = await getSymbolInfo(symbol)

    // 3. Get REAL portfolio equity
    const portfolioEquity = await getPortfolioEquity()

    // 4. Calculate order size
    const leverage = signal.leverage ?? 1
    const notionalAllocation = (portfolioEquity * signal.sizePct / 100) * leverage
    const rawSize = notionalAllocation / price

    // 5. Round to step size
    const quantity = binanceClient.roundStep(rawSize, info.stepSize)

    // 6. Check quantity > 0 and actual post-rounding notional >= minimum (5 USDT)
    // Must check AFTER rounding: roundStep can return "0" for very small sizes.
    const qtyNum = parseFloat(quantity)
    const minNotional = parseFloat(info.minNotional)
    const actualNotional = qtyNum * price
    if (qtyNum <= 0 || actualNotional < minNotional) {
      return {
        success: false,
        signalId: signal.id,
        protocol: 'binance',
        error: `Order size invalid after rounding: qty=${quantity}, notional=$${actualNotional.toFixed(2)}, min=$${minNotional}`,
        timestamp: Date.now(),
      }
    }

    const slippagePct = getSlippagePct(signal.asset)
    const side = signal.direction === 'long' ? 'BUY' : 'SELL'

    log.info(
      {
        symbol,
        direction: signal.direction,
        markPrice: price.toFixed(2),
        quantity,
        leverage: leverage.toFixed(1) + 'x',
        notional: notionalAllocation.toFixed(2),
        portfolioEquity: portfolioEquity.toFixed(2),
        slippage: (slippagePct * 100).toFixed(3) + '%',
        signalId: signal.id,
        dryRun: config.dryRun,
        stopLoss: signal.stopLossPct ? (signal.stopLossPct * 100).toFixed(1) + '%' : 'none',
        takeProfit: signal.takeProfitPct ? (signal.takeProfitPct * 100).toFixed(1) + '%' : 'none',
      },
      config.dryRun ? 'DRY RUN — order NOT sent' : 'Placing Binance order (LIVE)',
    )

    // 7. Build entry order
    const orderParams: BinanceOrderParams = {
      symbol,
      side,
      type: 'MARKET',
      quantity,
    }

    // ─── DRY RUN: Log but don't send ────────────────────────────────
    if (config.dryRun) {
      log.info({ orderParams }, 'Binance order prepared (DRY RUN — set DRY_RUN=false to execute)')
      return {
        success: true,
        signalId: signal.id,
        protocol: 'binance',
        orderId: `dry-${signal.id}`,
        executedSize: quantity,
        executedPrice: price.toFixed(2),
        timestamp: Date.now(),
        metadata: {
          dryRun: true, slippagePct, basePrice: price,
          symbol,
          maxHoldingHours: signal.maxHoldingHours ?? 0,
          proposalId: signal.proposalId,
          asset: signal.asset,
        },
      }
    }

    // ─── LIVE EXECUTION ─────────────────────────────────────────────

    // Set leverage + margin mode before order
    await binanceClient.setLeverage(symbol, leverage)
    await binanceClient.setMarginType(symbol, 'CROSSED')

    // Place market order
    const result = await binanceClient.placeOrder({
      symbol,
      side,
      type: 'MARKET',
      quantity,
    })

    // Place protective orders after entry — use actual fill price (avgPrice) for accurate SL/TP levels
    const fillPrice = parseFloat(result.avgPrice) || price
    await placeProtectiveOrders(symbol, signal, fillPrice, quantity, info.tickSize)

    return {
      success: true,
      signalId: signal.id,
      protocol: 'binance',
      orderId: String(result.orderId),
      executedSize: result.executedQty,
      executedPrice: result.avgPrice,
      timestamp: Date.now(),
      metadata: {
        dryRun: false, slippagePct, basePrice: price,
        symbol,
        maxHoldingHours: signal.maxHoldingHours ?? 0,
        proposalId: signal.proposalId,
        asset: signal.asset,
      },
    }
  } catch (err) {
    log.error({ err, signalId: signal.id }, 'Binance order execution failed')
    return {
      success: false,
      signalId: signal.id,
      protocol: 'binance',
      error: err instanceof Error ? err.message : String(err),
      timestamp: Date.now(),
    }
  }
}

// ─── Protective Orders ──────────────────────────────────────────────

async function placeProtectiveOrders(
  symbol: string,
  signal: TradeSignal,
  entryPrice: number,
  quantity: string,
  tickSize: string,
): Promise<void> {
  const closeSide = signal.direction === 'long' ? 'SELL' : 'BUY'

  // Stop-Loss (STOP_MARKET) — hard floor protection against immediate adverse moves
  if (signal.stopLossPct && signal.stopLossPct > 0) {
    const slPrice = signal.direction === 'long'
      ? entryPrice * (1 - signal.stopLossPct)
      : entryPrice * (1 + signal.stopLossPct)
    const stopPrice = binanceClient.roundTick(slPrice, tickSize)

    try {
      const result = await binanceClient.placeOrder({
        symbol,
        side: closeSide,
        type: 'STOP_MARKET',
        quantity,
        stopPrice,
        reduceOnly: true,
      })
      log.info({ symbol, stopPrice, orderId: result.orderId }, 'Stop-loss order placed')
    } catch (err) {
      log.error({ err, symbol }, 'CRITICAL: Stop-loss placement FAILED — position is UNPROTECTED')
    }
  }

  // Trailing Stop (TRAILING_STOP_MARKET) — locks in profits after activation
  // Activates when price moves trailingStopActivation% in our favour, then trails
  // by trailingStopDistance% from the best price reached.
  // This replicates the backtest's trailing stop logic in live.
  if (signal.trailingStopActivation && signal.trailingStopDistance) {
    // Binance callbackRate is in percent, clamped to [0.1, 5.0]
    const callbackRate = Math.max(0.1, Math.min(signal.trailingStopDistance * 100, TRAILING_STOP_MAX_CALLBACK_RATE))
    const activationPrice = signal.direction === 'long'
      ? entryPrice * (1 + signal.trailingStopActivation)
      : entryPrice * (1 - signal.trailingStopActivation)
    const activationPriceStr = binanceClient.roundTick(activationPrice, tickSize)

    try {
      // TRAILING_STOP_MARKET must use the Algo Trading API endpoint.
      // The regular /fapi/v1/order endpoint rejects it with error -4120.
      const result = await binanceClient.placeTrailingStopAlgo({
        symbol,
        side: closeSide,
        quantity,
        callbackRate,
        activationPrice: activationPriceStr,
        reduceOnly: true,
      })
      log.info(
        {
          symbol, algoId: result.algoId,
          activationPrice: activationPriceStr,
          callbackRate: callbackRate.toFixed(1) + '%',
          backtestDistance: (signal.trailingStopDistance * 100).toFixed(1) + '%',
        },
        'Trailing stop algo order placed',
      )
    } catch (err) {
      log.warn({ err, symbol }, 'Trailing stop placement failed — static stop-loss still active')
    }
  }

  // Take-Profit (TAKE_PROFIT_MARKET)
  if (signal.takeProfitPct && signal.takeProfitPct > 0) {
    const tpPrice = signal.direction === 'long'
      ? entryPrice * (1 + signal.takeProfitPct)
      : entryPrice * (1 - signal.takeProfitPct)
    const stopPrice = binanceClient.roundTick(tpPrice, tickSize)

    try {
      const result = await binanceClient.placeOrder({
        symbol,
        side: closeSide,
        type: 'TAKE_PROFIT_MARKET',
        quantity,
        stopPrice,
        reduceOnly: true,
      })
      log.info({ symbol, stopPrice, orderId: result.orderId }, 'Take-profit order placed')
    } catch (err) {
      log.warn({ err, symbol }, 'Take-profit placement failed')
    }
  }
}

/**
 * Cancel all open orders for a symbol.
 * Call this after position closure to clean up any remaining protective orders.
 */
export async function cancelPositionOrders(symbol: string): Promise<void> {
  await binanceClient.cancelAllOpenOrders(symbol)
}

/**
 * Reduce an existing Binance position by a percentage.
 */
export async function reducePosition(
  symbol: string,
  currentSize: string,
  reducePct: number,
): Promise<ExecutionResult> {
  const size = parseFloat(currentSize)
  const reduceSize = Math.abs(size) * (reducePct / 100)
  const side = size > 0 ? 'SELL' : 'BUY' // Close direction

  // Get step size for rounding
  const info = await getSymbolInfo(symbol)
  const quantity = binanceClient.roundStep(reduceSize, info.stepSize)

  // Guard: rounding can produce 0 for very small positions — abort to avoid API error
  if (parseFloat(quantity) <= 0) {
    log.warn({ symbol, currentSize, reducePct, reduceSize, quantity }, 'Reduce order skipped: quantity rounds to 0')
    return {
      success: false,
      signalId: `reduce-${symbol}`,
      protocol: 'binance',
      error: `Reduce qty rounds to 0 (size=${currentSize}, reducePct=${reducePct})`,
      timestamp: Date.now(),
    }
  }

  log.info({ symbol, currentSize, reducePct, quantity }, 'Reducing Binance position')

  if (config.dryRun) {
    log.info({ symbol, quantity, side }, 'Reduce order prepared (DRY RUN)')
    return {
      success: true,
      signalId: `reduce-${symbol}`,
      protocol: 'binance',
      orderId: `dry-reduce-${Date.now()}`,
      executedSize: quantity,
      timestamp: Date.now(),
    }
  }

  try {
    const result = await binanceClient.placeOrder({
      symbol,
      side,
      type: 'MARKET',
      quantity,
      reduceOnly: true,
    })
    return {
      success: true,
      signalId: `reduce-${symbol}`,
      protocol: 'binance',
      orderId: String(result.orderId),
      executedSize: result.executedQty,
      timestamp: Date.now(),
    }
  } catch (err) {
    log.error({ err, symbol }, 'Reduce order failed')
    return {
      success: false,
      signalId: `reduce-${symbol}`,
      protocol: 'binance',
      error: err instanceof Error ? err.message : String(err),
      timestamp: Date.now(),
    }
  }
}
