/**
 * Risk manager.
 * Governance-stage stop-loss state machine + position limits + health factor monitoring.
 * Validates trade signals before execution and manages progressive position reduction.
 */
import { eventBus } from '../lib/eventBus.js'
import { createLogger } from '../lib/logger.js'
import type { GovernanceStage } from '../types/governance.js'
import type { TradeSignal, Position } from '../types/trading.js'

const log = createLogger('risk-manager')

// ─── Configuration ──────────────────────────────────────────────────

export interface RiskConfig {
  maxSinglePositionPct: number    // Max single position as % of portfolio (e.g., 20)
  maxTotalExposurePct: number     // Max total exposure as % of portfolio (e.g., 80)
  maxDrawdownPct: number          // Max drawdown before emergency exit (e.g., 15)
  aaveHfAlertThreshold: number    // Alert when Aave HF drops below this (e.g., 1.5)
  aaveHfReduceThreshold: number   // Reduce position when HF drops below this (e.g., 1.2)
  minConfidence: number           // Minimum confidence to execute a signal (e.g., 0.3)
}

const DEFAULT_CONFIG: RiskConfig = {
  maxSinglePositionPct: 20,
  maxTotalExposurePct: 80,
  maxDrawdownPct: 15,
  aaveHfAlertThreshold: 1.5,
  aaveHfReduceThreshold: 1.2,
  minConfidence: 0.3,
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

const trackedPositions = new Map<string, TrackedGovernancePosition>()

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

    // 2. Single position size limit
    if (signal.sizePct > this.config.maxSinglePositionPct) {
      log.warn(
        { signalId: signal.id, sizePct: signal.sizePct, max: this.config.maxSinglePositionPct },
        'Signal size capped to max single position limit',
      )
      signal = { ...signal, sizePct: this.config.maxSinglePositionPct }
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
    if (stageConfig && stageConfig.maxPositionPct === 0) {
      log.info(
        { signalId: signal.id, stage: signal.governanceStage },
        'Signal rejected: proposal already executed',
      )
      return null
    }

    // 5. Drawdown check
    if (this.isDrawdownExceeded()) {
      log.warn('Signal rejected: portfolio drawdown limit exceeded')
      return null
    }

    log.info(
      { signalId: signal.id, asset: signal.asset, sizePct: signal.sizePct.toFixed(2) },
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
    for (const [key, tracked] of trackedPositions) {
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

  private calculateCurrentExposurePct(): number {
    if (this.portfolioValue <= 0) return 0

    const totalExposure = this.currentPositions.reduce((sum, p) => {
      const size = Math.abs(parseFloat(p.size || '0'))
      const price = parseFloat(p.currentPrice || '0')
      return sum + size * price
    }, 0)

    return (totalExposure / this.portfolioValue) * 100
  }

  private isDrawdownExceeded(): boolean {
    const totalPnl = this.currentPositions.reduce((sum, p) => {
      return sum + parseFloat(p.unrealizedPnl || '0')
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
  eventBus.on('position:update', (update) => {
    const hfAlerts = riskManager.checkHealthFactors()
    for (const alert of hfAlerts) {
      eventBus.emit('alert:send', {
        id: `hf-${alert.positionId}-${Date.now()}`,
        type: 'health_warning',
        severity: alert.action === 'reduce' ? 'critical' : 'warning',
        channel: 'both',
        title: `Aave Health Factor ${alert.action === 'reduce' ? 'CRITICAL' : 'Warning'}`,
        message: `Position ${alert.positionId} HF: ${alert.hf.toFixed(4)}`,
        timestamp: Date.now(),
      })
    }
  })

  log.info('Risk manager wired to event bus')
}
