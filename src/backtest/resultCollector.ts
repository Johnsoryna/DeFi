/**
 * Result collector for backtesting.
 * Tracks all signals, executions, and open positions during a backtest run.
 * Computes portfolio value, equity curve, drawdown, and P&L.
 */
import { eventBus } from '../lib/eventBus.js'
import { createLogger } from '../lib/logger.js'
import { resolveAssetSymbol } from './assetResolver.js'
import type { Clock } from './clock.js'
import type { MockPriceMonitor } from './mockPrice.js'
import type { TradeSignal, ExecutionResult, Position, OrderSide, ExecutionProtocol } from '../types/trading.js'
import { recordTradeOutcome } from '../strategy/confidenceScorer.js'
import { recordStopLoss, recordWin, recordMonthlyPnl, recordGlobalLoss } from '../strategy/riskManager.js'
import { getMomentum } from '../strategy/priceService.js'

const log = createLogger('result-collector')

// ─── Fee Constants ──────────────────────────────────────────────────
// These mirror the mock executor's fee model for consistency.

const BINANCE_TAKER_FEE = 0.0005 // 0.05% taker fee — VIP0 rate, realistic for retail
const BINANCE_BASE_SLIPPAGE = 0.0003 // 0.03% base slippage (deep Binance order books)

const BINANCE_LIQUIDITY_MULTIPLIER: Record<string, number> = {
  // Must mirror mockExecutor.ts — based on Binance Futures volume data
  ETH: 1.0, WETH: 1.0, BTC: 1.0, WBTC: 1.0, CBBTC: 1.0,
  ATOM: 1.2, AVAX: 1.2, SUI: 1.2, POL: 1.2,
  APT: 1.2, AXL: 1.2, NEAR: 1.2, INJ: 1.2,
  AAVE: 1.5, BLUR: 1.5, JTO: 1.5,
  UNI: 1.5, OP: 1.5, COMP: 1.5, LINK: 1.5,
  MKR: 1.5, CRV: 1.5, YFI: 1.5,
  ZK: 2.0, JUP: 2.0, DRIFT: 2.0, STRK: 2.0, TIA: 2.0,
  ENA: 2.0, STX: 2.0,
  SEI: 2.0, LDO: 2.0, PYTH: 2.0,
  CVX: 2.0,
  ARB: 2.5, DYDX: 2.5,
  WSTETH: 2.0, RETH: 2.5, CBETH: 2.5,
}

/**
 * Calculate exit slippage for a Binance Futures trade.
 * Same model as the mock executor uses for entries.
 */
function calculateExitSlippage(asset: string, notionalUsd: number): number {
  const liquidityMult = BINANCE_LIQUIDITY_MULTIPLIER[asset.toUpperCase()] ?? 2.0
  const marketImpact = Math.max(0, (notionalUsd - 50000) / 200000 * 0.00005)
  return BINANCE_BASE_SLIPPAGE * liquidityMult + marketImpact + BINANCE_TAKER_FEE
}

// ─── Funding Rate Model ─────────────────────────────────────────────
// Binance Futures perpetual positions accrue funding every 8 hours.
// Funding rate depends on market conditions:
//   - Positive rate: longs pay shorts (typical in bull markets)
//   - Negative rate: shorts pay longs (typical in bear markets)
// We use a regime-based model: ETH 14d momentum determines direction & magnitude.
//   - Bull (ETH >+10%): +0.008% → shorts receive well
//   - Neutral:          +0.004% → mild positive rate
//   - Bear (ETH <-10%): -0.003% → shorts PAY (inverted)

const FUNDING_RATE_BULL  = 0.00008  // +0.008% per 8h in bull market  (~8.8% annualized)
const FUNDING_RATE_NEUTRAL = 0.00004 // +0.004% per 8h neutral        (~4.4% annualized)
const FUNDING_RATE_BEAR  = -0.00003  // -0.003% per 8h in bear market  (~-3.3% annualized)
const FUNDING_INTERVAL_MS = 8 * 3600_000 // 8 hours

// ─── Exported Types ──────────────────────────────────────────────────

export interface TrackedTrade {
  signal: TradeSignal
  execution: ExecutionResult | null
  entryPrice: number
  exitPrice: number | null
  size: number            // token units
  direction: OrderSide
  asset: string
  protocol: ExecutionProtocol
  pnl: number | null
  holdingPeriodMs: number | null
  openedAt: number
  closedAt: number | null
  exitReason: string | null
}

export interface EquityPoint {
  timestamp: number
  equity: number
}

export interface ProtocolBreakdown {
  protocol: string
  signalCount: number
  executionCount: number
  totalPnl: number
}

export interface ProposalBreakdown {
  proposalId: string
  signalCount: number
  totalPnl: number
  bestPnl: number
  worstPnl: number
}

// ─── Internal Open Position ──────────────────────────────────────────

interface OpenPosition {
  tradeIndex: number      // index into this.trades
  asset: string
  resolvedAsset: string   // resolved symbol for price lookups
  direction: OrderSide
  size: number            // token units (leveraged)
  entryPrice: number
  notional: number        // entry dollar value (leveraged notional)
  margin: number          // actual cash allocated (notional / leverage)
  leverage: number        // leverage multiplier
  protocol: ExecutionProtocol
  proposalId: string
  openedAt: number
  // TP/SL from signal
  stopLossPct: number
  takeProfitPct: number
  trailingStopActivation: number
  trailingStopDistance: number
  maxHoldingMs: number
  // Trailing stop tracking
  peakPnlPct: number      // highest PnL % reached (for trailing stop)
  trailingStopActive: boolean
  // Funding rate tracking
  accumulatedFunding: number   // total funding accrued (positive = received, negative = paid)
  lastFundingTimestamp: number // last time funding was applied
}

// ─── Result Collector ────────────────────────────────────────────────

export class ResultCollector {
  /** All trade signals received (before risk validation). */
  readonly signals: TradeSignal[] = []

  /** Signals that passed risk validation. */
  readonly validatedSignals: TradeSignal[] = []

  /** All execution results (successes and failures). */
  readonly executions: ExecutionResult[] = []

  /** All tracked trades (open and closed). */
  readonly trades: TrackedTrade[] = []

  /** Equity curve data points. */
  readonly equityCurve: EquityPoint[] = []

  private openPositions: OpenPosition[] = []
  private cashBalance: number
  private initialPortfolio: number
  private peakEquity: number
  private maxDrawdownFraction: number = 0
  // Circuit breaker: pause trading after major drawdown
  private circuitBreakerUntil: number = 0
  private readonly CIRCUIT_BREAKER_DRAWDOWN = 0.25 // 25% drawdown triggers pause (aligned with maxDrawdownPct)
  private readonly CIRCUIT_BREAKER_COOLDOWN_MS = 3 * 24 * 3600_000 // 3 days pause (shorter to avoid missing alpha)

  constructor(
    private clock: Clock,
    private priceMonitor: MockPriceMonitor,
    initialPortfolio: number,
  ) {
    this.initialPortfolio = initialPortfolio
    this.cashBalance = initialPortfolio
    this.peakEquity = initialPortfolio
  }

  /**
   * Start listening to event bus for signals, validations, and executions.
   */
  start(): void {
    eventBus.on('signal:trade', (signal: TradeSignal) => {
      this.signals.push(signal)
    })

    eventBus.on('signal:validated', (signal: TradeSignal) => {
      this.validatedSignals.push(signal)
    })

    eventBus.on('execution:result', (result: ExecutionResult) => {
      this.executions.push(result)

      if (result.success && result.executedPrice && result.executedSize) {
        this.openTrade(result)
      }
    })

    // Record initial equity point
    this.equityCurve.push({
      timestamp: this.clock.now(),
      equity: this.initialPortfolio,
    })

    log.info({ initialPortfolio: this.initialPortfolio }, 'Result collector started')
  }

  /**
   * Get the current total portfolio value (cash + open positions).
   */
  getPortfolioValue(): number {
    let positionValue = 0

    for (const pos of this.openPositions) {
      positionValue += this.getPositionValue(pos)
    }

    return this.cashBalance + positionValue
  }

  /**
   * Get current open positions in the standard Position format.
   * Used by the signal generator to check for duplicate positions.
   */
  getCurrentPositions(): Position[] {
    return this.openPositions.map((pos) => {
      const currentPrice = this.priceMonitor.getPrice(pos.resolvedAsset, this.clock.now())
      const currentPriceNum = currentPrice ? parseFloat(currentPrice) : pos.entryPrice
      const unrealizedPnl = this.calculatePnl(pos, currentPriceNum)

      return {
        id: `bt-${pos.tradeIndex}`,
        protocol: 'binance' as const,
        type: 'perp' as const,
        asset: pos.asset,
        size: (pos.direction === 'short' ? -pos.size : pos.size).toString(),
        entryPrice: pos.entryPrice.toString(),
        currentPrice: currentPriceNum.toString(),
        unrealizedPnl: unrealizedPnl.toString(),
        realizedPnl: '0',
        accruedYield: '0',
        leverage: pos.leverage,
        lastUpdated: new Date(this.clock.now()).toISOString(),
      } satisfies Position
    })
  }

  /**
   * Close all open positions at current market price.
   * Called at end of backtest to realize all P&L.
   */
  closeAllPositions(): void {
    // Close in reverse order to avoid index shifting issues
    const positionsToClose = [...this.openPositions]
    for (const pos of positionsToClose) {
      this.closePosition(pos)
    }

    // Record final equity point
    this.recordEquityPoint()

    log.info(
      { closedCount: positionsToClose.length, finalValue: this.getPortfolioValue() },
      'All positions closed',
    )
  }

  /**
   * Periodic exit check — called during replay every N simulated hours.
   * Updates equity curve and checks stop-loss / take-profit.
   */
  checkExits(): void {
    // Accrue funding for all open positions before checking exits
    this.accrueAllFunding()

    this.recordEquityPoint()

    const toClose: Array<{ pos: OpenPosition; reason: string }> = []

    for (const pos of this.openPositions) {
      const currentPrice = this.priceMonitor.getPrice(pos.resolvedAsset, this.clock.now())
      if (!currentPrice) continue

      const price = parseFloat(currentPrice)
      const pnl = this.calculatePnl(pos, price)
      // P&L as % of MARGIN (not notional) — this reflects actual account impact
      const _pnlPctOfMargin = pos.margin > 0 ? pnl / pos.margin : 0
      // Price change % from entry
      const priceChangePct = pos.direction === 'long'
        ? (price - pos.entryPrice) / pos.entryPrice
        : (pos.entryPrice - price) / pos.entryPrice

      // Update peak P&L tracking for trailing stops
      if (priceChangePct > pos.peakPnlPct) {
        pos.peakPnlPct = priceChangePct
      }

      // 0. MAX ABSOLUTE LOSS: cap any single trade loss at 10% of initial portfolio.
      // Prevents catastrophic losses from high-leverage positions while allowing winners to run.
      // DO NOT reduce below 10% — sensitivity analysis shows trades need room to recover:
      // reducing to 7.5% costs $12K because some trades temporarily dip past -7.5% but recover.
      const maxAbsLoss = this.initialPortfolio * 0.10
      if (pnl < -maxAbsLoss) {
        toClose.push({
          pos,
          reason: `max-loss-cap (PnL $${pnl.toFixed(0)} exceeds -$${maxAbsLoss.toFixed(0)})`,
        })
        continue
      }

      // 1. STOP-LOSS with TIME-DECAY (Alpha Decay)
      // Governance alpha has a "half-life" — if the trade hasn't worked after 14+ days,
      // the alpha is fading. Tighten SL to cut losers faster.
      // Previous: started at 7 days → too aggressive, stopped out winners prematurely
      // Now: starts at 14 days, decays to 65% floor over 3 weeks, aligned with
      // 21-day max holding period for governance trades.
      const holdingMs = this.clock.now() - pos.openedAt
      const holdingHours = holdingMs / 3600_000
      let effectiveSL = pos.stopLossPct
      if (priceChangePct < 0 && holdingHours > 336) {
        // Trade is losing AND held > 14 days: tighten SL progressively
        // Alpha decay: governance signal loses power over time
        // 14 days: start decay, 21 days: 83% of original, 28 days: 65%
        const decayWeeks = Math.min(3, (holdingHours - 336) / 168) // 0 to 3 weeks of decay
        const decayFactor = 1.0 - (decayWeeks * 0.117) // 1.0 → 0.65 over 3 weeks (gentler)
        effectiveSL = pos.stopLossPct * Math.max(0.65, decayFactor)
      }

      if (priceChangePct < -effectiveSL) {
        const isDecayed = effectiveSL < pos.stopLossPct
        toClose.push({
          pos,
          reason: `stop-loss${isDecayed ? ' (time-decayed)' : ''} (${(priceChangePct * 100).toFixed(2)}% < -${(effectiveSL * 100).toFixed(1)}%)`,
        })
        continue
      }

      // 2. LIQUIDATION CHECK: if loss exceeds margin (leveraged wipeout)
      if (pnl <= -pos.margin * 0.90) {
        toClose.push({ pos, reason: `near-liquidation (PnL ${pnl.toFixed(2)} vs margin ${pos.margin.toFixed(2)})` })
        continue
      }

      // 3. TAKE-PROFIT: based on signal's takeProfitPct (price-based)
      if (priceChangePct >= pos.takeProfitPct) {
        toClose.push({ pos, reason: `take-profit (${(priceChangePct * 100).toFixed(2)}% >= ${(pos.takeProfitPct * 100).toFixed(1)}%)` })
        continue
      }

      // 4. TRAILING STOP: activate when price has moved enough in our favor
      if (pos.trailingStopActivation > 0 && pos.trailingStopDistance > 0) {
        // Note: peakPnlPct is also updated earlier for breakeven stop

        if (!pos.trailingStopActive && priceChangePct >= pos.trailingStopActivation) {
          pos.trailingStopActive = true
          log.debug(
            { asset: pos.asset, priceChange: (priceChangePct * 100).toFixed(2) + '%' },
            'Trailing stop activated',
          )
        }

        // Dynamic trailing tightening: once profit exceeds 2× activation threshold,
        // tighten the trail distance by 25% to lock in more profit on big moves.
        let effectiveTrailDist = pos.trailingStopDistance
        if (pos.peakPnlPct >= pos.trailingStopActivation * 2) {
          effectiveTrailDist = pos.trailingStopDistance * 0.75
        }

        if (pos.trailingStopActive && pos.peakPnlPct - priceChangePct >= effectiveTrailDist) {
          toClose.push({
            pos,
            reason: `trailing-stop (peak ${(pos.peakPnlPct * 100).toFixed(2)}%, now ${(priceChangePct * 100).toFixed(2)}%, trail ${(effectiveTrailDist * 100).toFixed(1)}%)`,
          })
          continue
        }
      }

      // 5. MAX HOLDING TIME: close if held too long
      if (holdingMs >= pos.maxHoldingMs) {
        toClose.push({ pos, reason: `max-holding-time (${Math.round(holdingMs / 3600_000)}h)` })
        continue
      }
    }

    for (const { pos, reason } of toClose) {
      log.info({ asset: pos.asset, reason }, 'Exit triggered')
      this.closePosition(pos, reason)
    }
  }

  /**
   * Get the maximum drawdown as a fraction (0-1).
   * E.g., 0.12 means 12% drawdown from peak.
   */
  getMaxDrawdown(): number {
    return this.maxDrawdownFraction
  }

  // ─── Private Helpers ─────────────────────────────────────────────

  /**
   * Accrue funding for a single position based on elapsed time.
   * Binance Futures perpetuals accrue funding every 8 hours.
   * Positive funding rate: longs pay shorts (typical in bull markets).
   * Our strategy is predominantly short → we typically RECEIVE funding.
   */
  private accruePositionFunding(pos: OpenPosition): void {
    const now = this.clock.now()
    const elapsed = now - pos.lastFundingTimestamp
    if (elapsed < FUNDING_INTERVAL_MS) return

    const periods = Math.floor(elapsed / FUNDING_INTERVAL_MS)
    if (periods === 0) return

    // Determine funding rate from ETH 14d momentum (market regime proxy)
    const ethMomentum = getMomentum('ETH', now, 14)
    let fundingRate: number
    if (ethMomentum !== null && ethMomentum > 0.10) {
      fundingRate = FUNDING_RATE_BULL    // Bull: shorts receive more
    } else if (ethMomentum !== null && ethMomentum < -0.10) {
      fundingRate = FUNDING_RATE_BEAR    // Bear: funding inverts, shorts PAY
    } else {
      fundingRate = FUNDING_RATE_NEUTRAL // Neutral: mild positive rate
    }

    // Funding payment = notional * rate * periods
    // Positive rate: shorts receive, longs pay
    // Negative rate: shorts pay, longs receive
    const fundingPerPeriod = pos.notional * fundingRate
    const totalFunding = pos.direction === 'short'
      ? fundingPerPeriod * periods    // shorts: +rate=receive, -rate=pay
      : -fundingPerPeriod * periods   // longs: +rate=pay, -rate=receive

    pos.accumulatedFunding += totalFunding
    pos.lastFundingTimestamp += periods * FUNDING_INTERVAL_MS

    // Apply funding to cash balance in real-time (funding is settled periodically)
    this.cashBalance += totalFunding
  }

  /**
   * Accrue funding for all open positions.
   * Called during checkExits() to simulate periodic funding payments.
   */
  private accrueAllFunding(): void {
    for (const pos of this.openPositions) {
      this.accruePositionFunding(pos)
    }
  }

  private openTrade(result: ExecutionResult): void {
    // Find the matching validated signal
    const signal = this.validatedSignals.find((s) => s.id === result.signalId)
    if (!signal) {
      log.warn({ signalId: result.signalId }, 'Execution result has no matching validated signal')
      return
    }

    // ─── CIRCUIT BREAKER CHECK ──────────────────────────────────
    // Don't open new positions during cooldown after major drawdown.
    // Early recovery: if drawdown drops below 20% (5% buffer below trigger), reset the breaker.
    if (this.clock.now() < this.circuitBreakerUntil) {
      const currentEquity = this.getPortfolioValue()
      const currentDD = this.peakEquity > 0 ? (this.peakEquity - currentEquity) / this.peakEquity : 0
      if (currentDD < this.CIRCUIT_BREAKER_DRAWDOWN - 0.05) {
        log.info(
          { drawdown: (currentDD * 100).toFixed(1) + '%' },
          'Circuit breaker RESET — drawdown recovered below recovery threshold',
        )
        this.circuitBreakerUntil = 0
      } else {
        log.info(
          { asset: signal.asset, direction: signal.direction, cooldownUntil: new Date(this.circuitBreakerUntil).toISOString() },
          'Circuit breaker ACTIVE — rejecting new trade during cooldown',
        )
        return
      }
    }

    const entryPrice = parseFloat(result.executedPrice!)
    const size = parseFloat(result.executedSize!)

    if (entryPrice <= 0 || size <= 0) {
      log.warn({ entryPrice, size, signalId: result.signalId }, 'Invalid trade parameters')
      return
    }

    // ─── ONE POSITION PER MARKET GUARD ─────────────────────────────
    // Only allow one position per market to simplify risk management.
    // Use resolvedAsset so ETH/WETH, MATIC/STMATIC etc. are treated as same market.
    const resolvedAsset = resolveAssetSymbol(signal.asset)
    const existingOnAsset = this.openPositions.find(
      (p) => p.resolvedAsset.toUpperCase() === resolvedAsset.toUpperCase(),
    )
    if (existingOnAsset) {
      log.warn(
        {
          asset: signal.asset,
          newDirection: signal.direction,
          existingDirection: existingOnAsset.direction,
          signalId: result.signalId,
        },
        'Rejecting trade: position already open on this asset (one per market)',
      )
      return
    }
    // ─── end one position per market guard ────────────────────────

    const leverage = signal.leverage ?? 1
    const notional = size * entryPrice               // Full leveraged notional
    const margin = notional / leverage                // Actual cash allocated

    // Insufficient margin — reject to avoid negative cash balance
    if (this.cashBalance < margin) {
      log.warn(
        { asset: signal.asset, margin, cashBalance: this.cashBalance },
        'Insufficient margin — rejecting trade',
      )
      return
    }

    // ATR data available for future use (regime filter, position sizing)
    const atr = this.priceMonitor.getVolatility(resolvedAsset, this.clock.now(), 14)
    // Keep original signal SL/TP/trailing — proven to work for governance alpha
    const dynamicSL = signal.stopLossPct ?? 0.15
    const dynamicTP = signal.takeProfitPct ?? 0.30
    const dynamicTrailActivation = signal.trailingStopActivation ?? 0
    const dynamicTrailDistance = signal.trailingStopDistance ?? 0

    if (atr > 0) {
      log.debug({
        asset: signal.asset,
        direction: signal.direction,
        atr: (atr * 100).toFixed(2) + '%',
        signalSL: (dynamicSL * 100).toFixed(1) + '%',
      }, 'ATR data noted')
    }

    const trade: TrackedTrade = {
      signal,
      execution: result,
      entryPrice,
      exitPrice: null,
      size,
      direction: signal.direction,
      asset: signal.asset,
      protocol: signal.protocol,
      pnl: null,
      holdingPeriodMs: null,
      openedAt: this.clock.now(),
      closedAt: null,
      exitReason: null,
    }

    this.trades.push(trade)
    const tradeIndex = this.trades.length - 1

    // Reserve margin (not full notional — leverage means we only post margin)
    this.cashBalance -= margin

    this.openPositions.push({
      tradeIndex,
      asset: signal.asset,
      resolvedAsset,
      direction: signal.direction,
      size,
      entryPrice,
      notional,
      margin,
      leverage,
      protocol: signal.protocol,
      proposalId: signal.proposalId,
      openedAt: this.clock.now(),
      stopLossPct: dynamicSL,
      takeProfitPct: dynamicTP,
      trailingStopActivation: dynamicTrailActivation,
      trailingStopDistance: dynamicTrailDistance,
      maxHoldingMs: (signal.maxHoldingHours ?? 168) * 3600_000,
      peakPnlPct: 0,
      trailingStopActive: false,
      accumulatedFunding: 0,
      lastFundingTimestamp: this.clock.now(),
    })

    log.debug(
      {
        asset: signal.asset,
        direction: signal.direction,
        size: size.toFixed(4),
        entryPrice: entryPrice.toFixed(4),
        notional: notional.toFixed(2),
        margin: margin.toFixed(2),
        leverage: leverage.toFixed(1) + 'x',
        stopLoss: ((signal.stopLossPct ?? 0) * 100).toFixed(1) + '%',
        takeProfit: ((signal.takeProfitPct ?? 0) * 100).toFixed(1) + '%',
      },
      'Position opened',
    )

    // Notify risk manager of updated positions
    eventBus.emit('position:update', {
      positions: this.getCurrentPositions(),
      portfolioValue: this.getPortfolioValue(),
    })
  }

  private closePosition(pos: OpenPosition, exitReason?: string): void {
    const currentPrice = this.priceMonitor.getPrice(pos.resolvedAsset, this.clock.now())
    const rawExitPrice = currentPrice ? parseFloat(currentPrice) : pos.entryPrice

    // ─── EXIT SLIPPAGE + TAKER FEE ────────────────────────────────
    // In live trading, closing a position also incurs slippage and fees.
    // Closing a long (selling) = price slips DOWN; closing a short (buying back) = price slips UP.
    // Use current notional (size × currentPrice) instead of entry notional for realistic slippage
    const currentNotional = pos.size * rawExitPrice
    const exitSlippage = calculateExitSlippage(pos.asset, currentNotional)
    const exitSlippageMultiplier = pos.direction === 'long'
      ? 1 - exitSlippage   // selling → price is lower
      : 1 + exitSlippage   // buying back → price is higher
    const exitPrice = rawExitPrice * exitSlippageMultiplier

    // ─── FINAL FUNDING ACCRUAL ────────────────────────────────────
    // Apply any remaining funding since last accrual
    this.accruePositionFunding(pos)

    const rawPnl = this.calculatePnl(pos, exitPrice)
    // Total PnL = trading PnL + accumulated funding
    const pnl = rawPnl + pos.accumulatedFunding
    const holdingPeriodMs = this.clock.now() - pos.openedAt

    // Update the tracked trade
    const trade = this.trades[pos.tradeIndex]
    if (trade) {
      trade.exitPrice = exitPrice
      trade.pnl = pnl
      trade.holdingPeriodMs = holdingPeriodMs
      trade.closedAt = this.clock.now()
      trade.exitReason = exitReason ?? 'manual'
    }

    // Record outcome for adaptive Kelly
    recordTradeOutcome(pnl, pos.margin)

    // Record win/loss for consecutive loss cooldown
    // Track ALL losses (not just stop-loss) to catch losing streaks from any exit reason.
    if (pnl < 0) {
      recordStopLoss(pos.asset, this.clock.now())
      recordGlobalLoss(this.clock.now())
    } else if (pnl > 0) {
      recordWin(pos.asset)
    }

    // Record P&L for monthly loss budget
    recordMonthlyPnl(this.clock.now(), pnl)

    // Return margin + P&L (includes trading PnL + funding)
    this.cashBalance += pos.margin + pnl

    // Remove from open positions
    const idx = this.openPositions.indexOf(pos)
    if (idx >= 0) {
      this.openPositions.splice(idx, 1)
    }

    log.debug(
      {
        asset: pos.asset,
        direction: pos.direction,
        leverage: pos.leverage.toFixed(1) + 'x',
        entryPrice: pos.entryPrice.toFixed(4),
        exitPrice: exitPrice.toFixed(4),
        rawExitPrice: rawExitPrice.toFixed(4),
        exitSlippage: (exitSlippage * 100).toFixed(3) + '%',
        tradingPnl: rawPnl.toFixed(2),
        funding: pos.accumulatedFunding.toFixed(2),
        totalPnl: pnl.toFixed(2),
        holdingMs: holdingPeriodMs,
        reason: exitReason ?? 'manual',
      },
      'Position closed',
    )

    // Notify risk manager of updated positions after close
    eventBus.emit('position:update', {
      positions: this.getCurrentPositions(),
      portfolioValue: this.getPortfolioValue(),
    })
  }

  private calculatePnl(pos: OpenPosition, currentPrice: number): number {
    if (pos.direction === 'long') {
      return pos.size * (currentPrice - pos.entryPrice)
    } else {
      return pos.size * (pos.entryPrice - currentPrice)
    }
  }

  private getPositionValue(pos: OpenPosition): number {
    const currentPrice = this.priceMonitor.getPrice(pos.resolvedAsset, this.clock.now())
    const price = currentPrice ? parseFloat(currentPrice) : pos.entryPrice
    const pnl = this.calculatePnl(pos, price)
    // Position value = margin + unrealized P&L + accrued funding
    // Note: funding is already credited to cashBalance via accruePositionFunding,
    // so we don't add it here to avoid double-counting.
    return pos.margin + pnl
  }

  private recordEquityPoint(): void {
    const equity = this.getPortfolioValue()
    const ts = this.clock.now()

    // Avoid duplicate timestamps
    const last = this.equityCurve[this.equityCurve.length - 1]
    if (last && last.timestamp === ts) {
      last.equity = equity
    } else {
      this.equityCurve.push({ timestamp: ts, equity })
    }

    // Track peak and drawdown
    if (equity > this.peakEquity) {
      this.peakEquity = equity
    }

    if (this.peakEquity > 0) {
      const drawdown = (this.peakEquity - equity) / this.peakEquity
      if (drawdown > this.maxDrawdownFraction) {
        this.maxDrawdownFraction = drawdown
      }

      // Trigger circuit breaker if drawdown exceeds threshold
      if (drawdown >= this.CIRCUIT_BREAKER_DRAWDOWN && this.clock.now() >= this.circuitBreakerUntil) {
        this.circuitBreakerUntil = this.clock.now() + this.CIRCUIT_BREAKER_COOLDOWN_MS
        log.warn(
          {
            drawdown: (drawdown * 100).toFixed(1) + '%',
            threshold: (this.CIRCUIT_BREAKER_DRAWDOWN * 100) + '%',
            cooldownUntil: new Date(this.circuitBreakerUntil).toISOString(),
          },
          'Circuit breaker TRIGGERED — pausing new trades',
        )
      }
    }
  }
}
