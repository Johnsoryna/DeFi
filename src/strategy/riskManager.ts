/**
 * Risk manager.
 * Governance-stage stop-loss state machine + position limits + health factor monitoring.
 * Validates trade signals before execution and manages progressive position reduction.
 */
import { eventBus } from '../lib/eventBus.js'
import { createLogger } from '../lib/logger.js'
import { getClock } from '../backtest/clock.js'
import type { GovernanceStage } from '../types/governance.js'
import type { TradeSignal, Position } from '../types/trading.js'

const log = createLogger('risk-manager')


/** Parse a float safely, returning 0 for NaN/non-numeric strings */
function safeParseFloat(value: string | undefined): number {
  const n = parseFloat(value || '0')
  return Number.isFinite(n) ? n : 0
}

// ─── Configuration ──────────────────────────────────────────────────

export interface RiskConfig {
  maxSinglePositionPct: number    // Max single position as % of portfolio (e.g., 20)
  maxTotalExposurePct: number     // Max total exposure as % of portfolio (e.g., 80)
  maxDrawdownPct: number          // Max drawdown before emergency exit (e.g., 15)
  aaveHfAlertThreshold: number    // Alert when Aave HF drops below this (e.g., 1.5)
  aaveHfReduceThreshold: number   // Reduce position when HF drops below this (e.g., 1.2)
  minConfidence: number           // Minimum confidence to execute a signal (e.g., 0.3)
  maxLeverage: number             // Maximum allowed leverage multiplier (e.g., 10)
  maxLeveragedExposurePct: number // Max leveraged exposure as % of portfolio (e.g., 200)
  maxAssetConcentrationPct: number // Max % of portfolio exposed to a single asset (e.g., 40)
  consecutiveLossCooldownMs: number // Cooldown after N consecutive stop-losses on same asset (ms)
  consecutiveLossThreshold: number  // Number of stop-losses to trigger cooldown (e.g., 2)
}

const DEFAULT_CONFIG: RiskConfig = {
  maxSinglePositionPct: 12,     // Aligned with Kelly maxSizePct (12%) — secondary guard
  maxTotalExposurePct: 100,     // 21 protocols need headroom for concurrent positions
  maxDrawdownPct: 25,           // More protocols = more recovery opportunities
  aaveHfAlertThreshold: 1.5,
  aaveHfReduceThreshold: 1.2,
  minConfidence: 0.50,          // High bar: only trade high-conviction signals
  maxLeverage: 10,
  maxLeveragedExposurePct: 250, // Effective quality filter: blocks concurrent high-leverage positions
  maxAssetConcentrationPct: 40, // No single asset > 40% of portfolio
  consecutiveLossCooldownMs: 3 * 24 * 3600_000, // 3-day cooldown (shorter — signals decay)
  consecutiveLossThreshold: 2,  // 2 stop-losses on same asset triggers cooldown
}

// ─── Governance-Stage Stop-Loss State Machine ───────────────────────

interface StageConfig {
  maxPositionPct: number
  action: string
}

const STAGE_LIMITS: Record<GovernanceStage, StageConfig> = {
  monitoring:   { maxPositionPct: 100, action: 'none' },
  discussion:   { maxPositionPct: 100, action: 'alert_only' },
  snapshot:     { maxPositionPct: 75,  action: 'reduce_25pct' },
  onchain_vote: { maxPositionPct: 50,  action: 'reduce_to_50pct' },
  timelock:     { maxPositionPct: 25,  action: 'reduce_to_25pct' },
  executed:     { maxPositionPct: 0,   action: 'exit_fully' },
  canceled:     { maxPositionPct: 0,   action: 'exit_fully' },
}

// ─── State ──────────────────────────────────────────────────────────

interface TrackedGovernancePosition {
  proposalId: string
  positionId: string
  asset: string
  currentStage: GovernanceStage
  originalSizePct: number
  currentSizePct: number
}

// Note: This is a module-level Map that persists across RiskManager instances.
// For backtests, call resetTrackedPositions() between runs.
const trackedPositions = new Map<string, TrackedGovernancePosition>()

// ─── Consecutive Loss Tracker ────────────────────────────────────────
// Tracks stop-loss exits per asset to implement cooldown periods.
// After N consecutive stop-losses on the same asset, trading is paused
// for that asset to break losing streaks (general risk management, not overfitting).
interface AssetLossRecord {
  consecutiveLosses: number
  lastLossTimestamp: number
}

const assetLossTracker = new Map<string, AssetLossRecord>()

/**
 * Record a stop-loss exit for an asset. Increments consecutive loss counter.
 */
export function recordStopLoss(asset: string, timestamp: number): void {
  const key = asset.toUpperCase()
  const existing = assetLossTracker.get(key)
  if (existing) {
    existing.consecutiveLosses++
    existing.lastLossTimestamp = timestamp
  } else {
    assetLossTracker.set(key, { consecutiveLosses: 1, lastLossTimestamp: timestamp })
  }
}

/**
 * Record a profitable exit for an asset. Resets consecutive loss counter.
 */
export function recordWin(asset: string): void {
  const key = asset.toUpperCase()
  assetLossTracker.delete(key)
}

/**
 * Check if an asset is in cooldown after consecutive stop-losses.
 */
export function isAssetInCooldown(asset: string, now: number, config: RiskConfig): boolean {
  const key = asset.toUpperCase()
  const record = assetLossTracker.get(key)
  if (!record) return false

  if (record.consecutiveLosses >= config.consecutiveLossThreshold) {
    const elapsed = now - record.lastLossTimestamp
    if (elapsed < config.consecutiveLossCooldownMs) {
      return true
    }
    // Cooldown expired — reset
    assetLossTracker.delete(key)
  }
  return false
}

// ─── Global Loss Tracker ─────────────────────────────────────────────
// Tracks global consecutive losses (across all assets) for post-loss size reduction.
let globalConsecutiveLosses = 0

// ─── Monthly P&L Budget ─────────────────────────────────────────────
// Tracks P&L per calendar month to implement monthly loss budgets.
const monthlyPnl = new Map<string, number>()

/**
 * Record a global loss event (any asset). Used for post-loss size reduction.
 */
export function recordGlobalLoss(timestamp: number): void {
  globalConsecutiveLosses++
}

/**
 * Record trade P&L for monthly budget tracking.
 */
export function recordMonthlyPnl(timestamp: number, pnl: number): void {
  const date = new Date(timestamp)
  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
  const current = monthlyPnl.get(key) || 0
  monthlyPnl.set(key, current + pnl)
}

/**
 * Get global consecutive loss count (for post-loss sizing).
 */
export function getGlobalConsecutiveLosses(): number {
  return globalConsecutiveLosses
}

/**
 * Reset global loss counter (called after a win).
 */
export function resetGlobalLosses(): void {
  globalConsecutiveLosses = 0
}

/**
 * Reset tracked positions (for testing/backtest cleanup).
 */
export function resetTrackedPositions(): void {
  trackedPositions.clear()
  assetLossTracker.clear()
  globalConsecutiveLosses = 0
  monthlyPnl.clear()
}

export class RiskManager {
  private config: RiskConfig
  private currentPositions: Position[] = []
  private portfolioValue: number = 0

  constructor(riskConfig?: Partial<RiskConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...riskConfig }
  }

  /**
   * Update current portfolio state.
   */
  updatePortfolio(positions: Position[], portfolioValue: number): void {
    this.currentPositions = positions
    this.portfolioValue = portfolioValue
  }

  // ─── Signal Validation ──────────────────────────────────────────

  /**
   * Validate a trade signal against risk rules.
   * Returns the (potentially adjusted) signal, or null if rejected.
   */
  validateSignal(signal: TradeSignal): TradeSignal | null {
    // 1. Minimum confidence check
    if (signal.confidence < this.config.minConfidence) {
      log.info(
        { signalId: signal.id, confidence: signal.confidence, min: this.config.minConfidence },
        'Signal rejected: below minimum confidence',
      )
      return null
    }

    // 2. Single position size limit — cap base sizePct (leverage is applied on top separately)
    if (signal.sizePct > this.config.maxSinglePositionPct) {
      const cappedSize = this.config.maxSinglePositionPct
      log.warn(
        { signalId: signal.id, sizePct: signal.sizePct, leverage: signal.leverage ?? 1, max: this.config.maxSinglePositionPct },
        'Signal size capped to max single position limit',
      )
      signal = { ...signal, sizePct: cappedSize }
    }

    // 3. Total exposure check
    const currentExposure = this.calculateCurrentExposurePct()
    if (currentExposure + signal.sizePct > this.config.maxTotalExposurePct) {
      const maxAllowed = this.config.maxTotalExposurePct - currentExposure
      if (maxAllowed <= 0) {
        log.warn(
          { signalId: signal.id, currentExposure, maxTotal: this.config.maxTotalExposurePct },
          'Signal rejected: total exposure limit reached',
        )
        return null
      }
      signal = { ...signal, sizePct: maxAllowed }
    }

    // 4. Governance stage position limit
    const stageConfig = STAGE_LIMITS[signal.governanceStage as GovernanceStage]
    if (stageConfig) {
      if (stageConfig.maxPositionPct === 0) {
        log.info(
          { signalId: signal.id, stage: signal.governanceStage },
          'Signal rejected: proposal already executed',
        )
        return null
      }
      // Check if signal size exceeds stage limit
      if (signal.sizePct > stageConfig.maxPositionPct) {
        log.warn(
          { signalId: signal.id, sizePct: signal.sizePct, maxForStage: stageConfig.maxPositionPct },
          'Signal size capped to stage limit',
        )
        signal = { ...signal, sizePct: stageConfig.maxPositionPct }
      }
    }

    // 5. Drawdown check
    if (this.isDrawdownExceeded()) {
      log.warn('Signal rejected: portfolio drawdown limit exceeded')
      return null
    }

    // 5a. Asset concentration check
    // Prevents over-concentration on a single asset (e.g. 59% AAVE in backtest).
    // General best practice: no single asset > maxAssetConcentrationPct of portfolio.
    const assetExposurePct = this.getAssetExposurePct(signal.asset)
    const newAssetExposure = assetExposurePct + signal.sizePct
    if (newAssetExposure > this.config.maxAssetConcentrationPct) {
      const remaining = this.config.maxAssetConcentrationPct - assetExposurePct
      if (remaining <= 1) {
        log.warn(
          { signalId: signal.id, asset: signal.asset, currentExposure: assetExposurePct.toFixed(1), max: this.config.maxAssetConcentrationPct },
          'Signal rejected: asset concentration limit reached',
        )
        return null
      }
      log.warn(
        { signalId: signal.id, asset: signal.asset, sizePct: signal.sizePct.toFixed(2), cappedTo: remaining.toFixed(2) },
        'Signal size reduced due to asset concentration limit',
      )
      signal = { ...signal, sizePct: remaining }
    }

    // 5b. Consecutive loss cooldown: SOFT version
    // Instead of blocking trades entirely, reduce position size to 35% of original (65% reduction).
    // This preserves alpha capture while protecting against repeated losses.
    if (isAssetInCooldown(signal.asset, getClock().now(), this.config)) {
      const reducedSize = signal.sizePct * 0.35
      log.info(
        { signalId: signal.id, asset: signal.asset, originalSize: signal.sizePct.toFixed(2), reducedSize: reducedSize.toFixed(2) },
        'Signal size reduced to 35%: asset in cooldown after consecutive stop-losses',
      )
      signal = { ...signal, sizePct: reducedSize }
    }

    // 6. Leverage cap
    if (signal.leverage && signal.leverage > this.config.maxLeverage) {
      log.warn(
        { signalId: signal.id, leverage: signal.leverage, max: this.config.maxLeverage },
        'Leverage capped to max allowed',
      )
      signal = { ...signal, leverage: this.config.maxLeverage }
    }

    // 7. Leveraged exposure check (sizePct * leverage)
    const effectiveLeverage = signal.leverage ?? 1
    const leveragedExposure = signal.sizePct * effectiveLeverage
    const currentLeveragedExposure = this.calculateLeveragedExposurePct()
    if (currentLeveragedExposure + leveragedExposure > this.config.maxLeveragedExposurePct) {
      const maxAllowed = this.config.maxLeveragedExposurePct - currentLeveragedExposure
      if (maxAllowed <= 0) {
        log.warn(
          { signalId: signal.id, currentLeveragedExposure, max: this.config.maxLeveragedExposurePct },
          'Signal rejected: total leveraged exposure limit reached',
        )
        return null
      }
      // Reduce leverage to fit
      const newLeverage = Math.max(1, maxAllowed / signal.sizePct)
      signal = { ...signal, leverage: Math.round(newLeverage * 10) / 10 }
    }

    log.info(
      {
        signalId: signal.id,
        asset: signal.asset,
        sizePct: signal.sizePct.toFixed(2),
        leverage: (signal.leverage ?? 1).toFixed(1) + 'x',
        stopLoss: signal.stopLossPct ? (signal.stopLossPct * 100).toFixed(1) + '%' : 'none',
        takeProfit: signal.takeProfitPct ? (signal.takeProfitPct * 100).toFixed(1) + '%' : 'none',
      },
      'Signal validated',
    )

    return signal
  }

  // ─── Governance Stage Transitions ─────────────────────────────

  /**
   * Handle a governance stage transition.
   * Progressively reduces positions as proposals advance.
   * Returns reduction actions to execute.
   */
  handleStageTransition(
    proposalId: string,
    newStage: GovernanceStage,
  ): Array<{ positionId: string; reduceByPct: number }> {
    const actions: Array<{ positionId: string; reduceByPct: number }> = []
    const stageConfig = STAGE_LIMITS[newStage]

    // Find all positions linked to this proposal
    for (const [_key, tracked] of trackedPositions) {
      if (tracked.proposalId !== proposalId) continue

      tracked.currentStage = newStage

      if (stageConfig.maxPositionPct < tracked.currentSizePct) {
        const reduceByPct = tracked.currentSizePct - stageConfig.maxPositionPct

        actions.push({
          positionId: tracked.positionId,
          reduceByPct,
        })

        tracked.currentSizePct = stageConfig.maxPositionPct

        log.info(
          {
            proposalId,
            positionId: tracked.positionId,
            newStage,
            reduceByPct,
            newSizePct: tracked.currentSizePct,
          },
          'Stage transition — reducing position',
        )
      }
    }

    return actions
  }

  /**
   * Track a new governance-linked position.
   */
  trackPosition(proposalId: string, positionId: string, asset: string, sizePct: number): void {
    trackedPositions.set(`${proposalId}:${positionId}`, {
      proposalId,
      positionId,
      asset,
      currentStage: 'monitoring',
      originalSizePct: sizePct,
      currentSizePct: sizePct,
    })
  }

  // ─── Health Factor Monitoring ─────────────────────────────────

  /**
   * Check Aave positions for health factor warnings.
   * Returns alerts for positions that need attention.
   */
  checkHealthFactors(): Array<{ positionId: string; hf: number; action: 'alert' | 'reduce' }> {
    const alerts: Array<{ positionId: string; hf: number; action: 'alert' | 'reduce' }> = []

    for (const position of this.currentPositions) {
      if (position.protocol !== 'aave' || !position.healthFactor) continue

      if (position.healthFactor < this.config.aaveHfReduceThreshold) {
        alerts.push({
          positionId: position.id,
          hf: position.healthFactor,
          action: 'reduce',
        })
        log.warn(
          { positionId: position.id, hf: position.healthFactor },
          'Aave position HF critical — reduce required',
        )
      } else if (position.healthFactor < this.config.aaveHfAlertThreshold) {
        alerts.push({
          positionId: position.id,
          hf: position.healthFactor,
          action: 'alert',
        })
        log.info(
          { positionId: position.id, hf: position.healthFactor },
          'Aave position HF warning',
        )
      }
    }

    return alerts
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Calculate current exposure to a specific asset as % of portfolio.
   * Counts all positions on the same asset (regardless of direction/protocol).
   */
  private getAssetExposurePct(asset: string): number {
    if (this.portfolioValue <= 0) return 0
    const key = asset.toUpperCase()
    let exposure = 0
    for (const pos of this.currentPositions) {
      if (pos.asset.toUpperCase() === key) {
        const absSize = Math.abs(safeParseFloat(pos.size))
        const price = safeParseFloat(pos.currentPrice) || safeParseFloat(pos.entryPrice)
        exposure += absSize * price
      }
    }
    return (exposure / this.portfolioValue) * 100
  }

  private calculateCurrentExposurePct(): number {
    if (this.portfolioValue <= 0) return 0

    // GROSS exposure: sum of absolute values of all positions.
    // A 50% long + 50% short = 100% gross exposure (not 0% net).
    // This correctly reflects capital at risk for leveraged portfolios.
    const grossExposure = this.currentPositions.reduce((sum, p) => {
      const absSize = Math.abs(safeParseFloat(p.size))
      const price = safeParseFloat(p.currentPrice)
      return sum + absSize * price
    }, 0)

    return (grossExposure / this.portfolioValue) * 100
  }

  private calculateLeveragedExposurePct(): number {
    if (this.portfolioValue <= 0) return 0
    // Sum the leveraged (notional) exposure from all positions
    let totalLeveragedValue = 0
    for (const pos of this.currentPositions) {
      const absSize = Math.abs(parseFloat(pos.size))
      const price = parseFloat(pos.currentPrice) || parseFloat(pos.entryPrice)
      const posLeverage = pos.leverage ?? 1
      totalLeveragedValue += absSize * price * posLeverage
    }
    return (totalLeveragedValue / this.portfolioValue) * 100
  }

  private isDrawdownExceeded(): boolean {
    // Include BOTH unrealized AND realized losses for accurate drawdown.
    // Without realized losses, closed losers are "forgotten" and drawdown resets to 0.
    const totalPnl = this.currentPositions.reduce((sum, p) => {
      return sum + safeParseFloat(p.unrealizedPnl) + safeParseFloat(p.realizedPnl)
    }, 0)

    if (this.portfolioValue <= 0) return false
    const drawdownPct = Math.abs(Math.min(0, totalPnl)) / this.portfolioValue * 100
    return drawdownPct > this.config.maxDrawdownPct
  }
}

// ─── Event Bus Integration ──────────────────────────────────────────

/**
 * Wire risk manager to the event bus.
 * Validates signals before they reach the executor.
 */
export function wireRiskManager(riskManager: RiskManager): void {
  eventBus.on('signal:trade', (signal: TradeSignal) => {
    const validated = riskManager.validateSignal(signal)
    if (validated) {
      eventBus.emit('signal:validated', validated)
    }
  })

  // Monitor position updates for health factor checks
  eventBus.on('position:update', (_update) => {
    const hfAlerts = riskManager.checkHealthFactors()
    for (const alert of hfAlerts) {
      eventBus.emit('alert:send', {
        id: `hf-${alert.positionId}-${getClock().now()}`,
        type: 'health_warning',
        severity: alert.action === 'reduce' ? 'critical' : 'warning',
        channel: 'both',
        title: `Aave Health Factor ${alert.action === 'reduce' ? 'CRITICAL' : 'Warning'}`,
        message: `Position ${alert.positionId} HF: ${alert.hf.toFixed(4)}`,
        timestamp: getClock().now(),
      })
    }
  })

  log.info('Risk manager wired to event bus')
}
