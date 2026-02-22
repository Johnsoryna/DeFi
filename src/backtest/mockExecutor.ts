/**
 * Mock trade executor for backtesting.
 * Simulates trade execution analytically with configurable slippage and gas cost models.
 * Replaces the real tradeExecutor during backtest runs.
 *
 * Uses the asset resolver to map contract addresses → symbols for price lookups.
 */
import { eventBus } from '../lib/eventBus.js'
import { createLogger } from '../lib/logger.js'
import { resolveAssetSymbol } from './assetResolver.js'
import type { Clock } from './clock.js'
import type { MockPriceMonitor } from './mockPrice.js'
import type { TradeSignal, ExecutionResult } from '../types/trading.js'

const log = createLogger('mock-executor')

// ─── Slippage Model ─────────────────────────────────────────────────

export interface SlippageConfig {
  /** Slippage per protocol (as a fraction, e.g. 0.001 = 0.1%) */
  binance: number
}

const DEFAULT_SLIPPAGE: SlippageConfig = {
  binance: 0.0003,   // 0.03% base — Binance Futures have deep order books
}

// ─── Asset Liquidity Tiers for Binance Futures ──────────────────────
// Higher liquidity = lower slippage. Based on Binance Futures market depths.
// Binance generally has 5-10x more liquidity than dYdX.

const BINANCE_LIQUIDITY_MULTIPLIER: Record<string, number> = {
  // Tier 1: Extremely liquid ($500M+ 24h vol) — 1.0x base slippage
  ETH: 1.0, WETH: 1.0, BTC: 1.0, WBTC: 1.0, CBBTC: 1.0,
  // Tier A-High: Very liquid ($50M+ governance token vol) — 1.2x slippage
  ATOM: 1.2, AVAX: 1.2, SUI: 1.2, POL: 1.2,
  APT: 1.2, AXL: 1.2, NEAR: 1.2, INJ: 1.2,
  // Tier A-Mid: Liquid ($10M-50M vol) — 1.5x slippage
  AAVE: 1.5, BLUR: 1.5, JTO: 1.5,
  UNI: 1.5, OP: 1.5, COMP: 1.5, LINK: 1.5,
  MKR: 1.5, CRV: 1.5, YFI: 1.5,
  ARB: 1.5,   // Corrected from 2.5 — ARB Binance Futures has $50M+ daily vol (top-15 DeFi token)
  DYDX: 1.5,  // Corrected from 2.5 — declining but still $10M-50M range
  // Tier A-Low: Medium ($5M-10M vol) — 2.0x slippage
  ZK: 2.0, JUP: 2.0, DRIFT: 2.0, STRK: 2.0, TIA: 2.0,
  ENA: 2.0, STX: 2.0,
  SEI: 2.0, LDO: 2.0, PYTH: 2.0,
  CVX: 2.0,
  // Non-governance assets (reference)
  WSTETH: 2.0, RETH: 2.5, CBETH: 2.5,
  // Tier C assets (GMX, MORPHO, SKY, EIGEN) NOT in this map = default 2.0x
  // ─── Gruppe C (Feb 2026) ────────────────────────────────────────
  '1INCH': 2.0,   // $5M-15M vol tier
  // ─── Removed ────────────────────────────────────────────────────
  // FXS: REMOVED — 0 trades in backtest
  // BAL: REMOVED — no Binance USDT perp (delisted)
  // MNT: REMOVED — no Binance USDT perp (delisted), 0 backtest trades
  // XVS: REMOVED — 0 trades in backtest (venus: asset listing proposals)
  // RPL: REMOVED — 0 trades in backtest (rocketpool: partnership proposals)
}

// Binance Futures taker fee by 30-day volume tier:
// VIP 0 ($0–$15M):   0.0500% (without BNB discount) ← realistic for retail accounts
// VIP 0 with BNB:     0.0450%
// VIP 1 ($15M–$100M): 0.0400%
const BINANCE_TAKER_FEE = 0.0005 // 0.05% — VIP0 rate, conservative/realistic

/** Minimum order notional for Binance Futures (5 USDT) */
const BINANCE_MIN_NOTIONAL = 5

/**
 * Calculate realistic slippage for a Binance Futures trade.
 * Considers: base slippage + liquidity tier + market impact + taker fee
 */
function calculateBinanceSlippage(asset: string, notionalUsd: number): number {
  const baseSlip = DEFAULT_SLIPPAGE.binance
  const liquidityMult = BINANCE_LIQUIDITY_MULTIPLIER[asset.toUpperCase()] ?? 2.0

  // Market impact: larger positions move the market more
  // Binance has deeper books, so impact is lower per dollar
  const marketImpact = Math.max(0, (notionalUsd - 50000) / 200000 * 0.00005)

  return baseSlip * liquidityMult + marketImpact + BINANCE_TAKER_FEE
}

// ─── Gas Cost Model ─────────────────────────────────────────────────

export interface GasCostConfig {
  /** Estimated gas cost in ETH per protocol */
  binance: number
  /** ETH price in USD (used to convert gas costs) */
  ethPriceUsd: number
}

const DEFAULT_GAS_COSTS: GasCostConfig = {
  binance: 0,       // No on-chain gas for Binance Futures (centralized exchange)
  ethPriceUsd: 2500,
}

// ─── Mock Executor ──────────────────────────────────────────────────

export class MockExecutor {
  private slippage: SlippageConfig
  private gasCosts: GasCostConfig
  private executionCount = 0

  constructor(
    private priceMonitor: MockPriceMonitor,
    private clock: Clock,
    slippage?: Partial<SlippageConfig>,
    gasCosts?: Partial<GasCostConfig>,
    private getPortfolioValue?: () => number,
  ) {
    this.slippage = { ...DEFAULT_SLIPPAGE, ...slippage }
    this.gasCosts = { ...DEFAULT_GAS_COSTS, ...gasCosts }
  }

  /**
   * Simulate execution of a trade signal.
   * Returns an ExecutionResult with simulated fill price, fees, etc.
   */
  executeSignal(signal: TradeSignal): ExecutionResult {
    this.executionCount++

    // Resolve the asset to a price-lookup symbol
    const resolvedSymbol = resolveAssetSymbol(signal.asset)

    // Reject unresolvable assets (raw addresses that aren't in our mapping)
    if (resolvedSymbol.startsWith('0X') || resolvedSymbol.startsWith('0x')) {
      log.warn(
        { asset: signal.asset, resolved: resolvedSymbol, signalId: signal.id },
        'Unresolvable asset (unknown address) — skipping trade',
      )
      return {
        success: false,
        signalId: signal.id,
        protocol: signal.protocol,
        error: `Unknown asset address ${signal.asset} — not in address mapping`,
        timestamp: this.clock.now(),
      }
    }

    const price = this.priceMonitor.getPrice(resolvedSymbol, this.clock.now())

    if (!price) {
      log.warn(
        { asset: signal.asset, resolved: resolvedSymbol, signalId: signal.id },
        'No price available for asset',
      )
      return {
        success: false,
        signalId: signal.id,
        protocol: signal.protocol,
        error: `No price data for ${signal.asset} (resolved: ${resolvedSymbol}) at ${new Date(this.clock.now()).toISOString()}`,
        timestamp: this.clock.now(),
      }
    }

    const basePrice = parseFloat(price)

    // Calculate notional for market impact (need it before slippage)
    const portfolioValueEst = this.getPortfolioValue?.() ?? 100_000
    const leverageEst = signal.leverage ?? 1
    const notionalEst = (signal.sizePct / 100) * portfolioValueEst * leverageEst

    // Reject orders below Binance minimum notional (5 USDT)
    if (notionalEst < BINANCE_MIN_NOTIONAL) {
      log.warn(
        { asset: signal.asset, notional: notionalEst.toFixed(2), min: BINANCE_MIN_NOTIONAL },
        'Order below minimum notional — skipping trade',
      )
      return {
        success: false,
        signalId: signal.id,
        protocol: signal.protocol,
        error: `Order notional $${notionalEst.toFixed(2)} below Binance minimum $${BINANCE_MIN_NOTIONAL}`,
        timestamp: this.clock.now(),
      }
    }

    // Asset-specific slippage for Binance Futures
    const slippagePct = calculateBinanceSlippage(signal.asset, notionalEst)

    // Apply slippage: buys pay more, sells receive less
    const slippageMultiplier = signal.direction === 'long'
      ? 1 + slippagePct
      : 1 - slippagePct
    const executionPrice = basePrice * slippageMultiplier

    // Guard against zero execution price
    if (executionPrice <= 0) {
      log.warn({ asset: signal.asset, basePrice, executionPrice }, 'Invalid execution price — skipping trade')
      return {
        success: false,
        signalId: signal.id,
        protocol: signal.protocol,
        error: `Invalid execution price: ${executionPrice}`,
        timestamp: this.clock.now(),
      }
    }

    // Calculate gas cost in USD (use local variable to avoid mutating shared config)
    const gasCostEth = this.gasCosts[signal.protocol] ?? 0.005
    const ethPrice = this.priceMonitor.getPrice('WETH', this.clock.now())
      ?? this.priceMonitor.getPrice('ETH', this.clock.now())
    const currentEthPriceUsd = ethPrice ? parseFloat(ethPrice) : this.gasCosts.ethPriceUsd
    const gasCostUsd = gasCostEth * currentEthPriceUsd

    // Convert sizePct (% of portfolio) to actual token units, applying leverage
    const portfolioValue = this.getPortfolioValue?.() ?? 100_000
    const leverage = signal.leverage ?? 1
    const dollarAllocation = (signal.sizePct / 100) * portfolioValue
    const leveragedAllocation = dollarAllocation * leverage
    const tokenUnits = leveragedAllocation / executionPrice

    const result: ExecutionResult = {
      success: true,
      signalId: signal.id,
      protocol: signal.protocol,
      orderId: `bt-${this.executionCount}`,
      executedSize: tokenUnits.toString(),
      executedPrice: executionPrice.toFixed(6),
      timestamp: this.clock.now(),
      metadata: {
        gasCostUsd: gasCostUsd,
        slippagePct: slippagePct,
        basePrice: basePrice,
        leverage: leverage,
        dollarAllocation: dollarAllocation,
        leveragedAllocation: leveragedAllocation,
      },
    }

    log.info(
      {
        signalId: signal.id,
        asset: signal.asset,
        resolved: resolvedSymbol,
        direction: signal.direction,
        basePrice: basePrice.toFixed(4),
        execPrice: executionPrice.toFixed(4),
        leverage: leverage.toFixed(1) + 'x',
        notional: leveragedAllocation.toFixed(2),
        slippage: `${(slippagePct * 100).toFixed(3)}%`,
        gasCostUsd: gasCostUsd.toFixed(2),
      },
      'Mock trade executed',
    )

    return result
  }

  /**
   * Wire the mock executor to the event bus.
   * Listens for signal:validated and emits execution:result.
   */
  wire(): void {
    eventBus.on('signal:validated', (signal: TradeSignal) => {
      const result = this.executeSignal(signal)
      eventBus.emit('execution:result', result)
    })

    log.info('Mock executor wired to event bus')
  }

  /** Get total executions so far. */
  getExecutionCount(): number {
    return this.executionCount
  }
}
