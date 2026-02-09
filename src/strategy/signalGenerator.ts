/**
 * Signal generator.
 * Converts ProposalAnalysis + CascadeImpact + Portfolio + Prices → TradeSignal.
 * Rule engine maps impact categories to trade directions with confidence scoring.
 */
import { randomUUID } from 'node:crypto'
import { eventBus } from '../lib/eventBus.js'
import { createLogger } from '../lib/logger.js'
import type {
  ProposalAnalysis,
  ProposalImpact,
  GovernanceStage,
  ImpactCategory,
} from '../types/governance.js'
import type { TradeSignal, OrderSide, ExecutionProtocol, Position } from '../types/trading.js'
import { getPrice } from '../processing/priceMonitor.js'

const log = createLogger('signal-gen')

// ─── Governance Stage → Confidence Multiplier ───────────────────────

const STAGE_CONFIDENCE: Record<GovernanceStage, number> = {
  monitoring: 0.1,
  discussion: 0.2,
  snapshot: 0.4,
  onchain_vote: 0.6,
  timelock: 0.85,
  executed: 1.0,
}

// ─── Impact Category → Trade Rule ───────────────────────────────────

interface TradeRule {
  direction: OrderSide
  protocol: ExecutionProtocol
  baseSizePct: number // Base position size as % of portfolio
  baseConfidence: number
  urgency: 'low' | 'medium' | 'high'
  rationale: string
}

/**
 * Rules for generating trade signals from proposal impacts.
 * Each impact category maps to one or more trade rules.
 */
function getTradeRules(
  impact: ProposalImpact,
  isDecrease: boolean,
): TradeRule[] {
  const rules: TradeRule[] = []

  switch (impact.category) {
    case 'ltv_change':
    case 'liquidation_threshold_change':
      if (isDecrease) {
        // LTV/LT decrease → liquidation cascade risk → short affected asset
        rules.push({
          direction: 'short',
          protocol: 'dydx',
          baseSizePct: 5,
          baseConfidence: 0.7,
          urgency: 'high',
          rationale: `LT decrease on ${impact.asset} may trigger liquidation cascade`,
        })
      } else {
        // LTV/LT increase → more borrowing capacity → bullish
        rules.push({
          direction: 'long',
          protocol: 'dydx',
          baseSizePct: 3,
          baseConfidence: 0.5,
          urgency: 'medium',
          rationale: `LT increase on ${impact.asset} unlocks borrowing capacity`,
        })
      }
      break

    case 'supply_cap_change':
      if (!isDecrease) {
        // Supply cap increase → more utility for the asset → bullish
        rules.push({
          direction: 'long',
          protocol: 'dydx',
          baseSizePct: 3,
          baseConfidence: 0.5,
          urgency: 'medium',
          rationale: `Supply cap increase on ${impact.asset} signals growth`,
        })
      }
      break

    case 'borrow_cap_change':
      if (!isDecrease) {
        rules.push({
          direction: 'long',
          protocol: 'dydx',
          baseSizePct: 2,
          baseConfidence: 0.4,
          urgency: 'low',
          rationale: `Borrow cap increase on ${impact.asset} increases utility`,
        })
      }
      break

    case 'reserve_freeze':
      // Freeze → short the frozen asset, buy PT on Pendle (rates spike on fear)
      rules.push({
        direction: 'short',
        protocol: 'dydx',
        baseSizePct: 5,
        baseConfidence: 0.8,
        urgency: 'high',
        rationale: `Reserve freeze on ${impact.asset} — flight to safety`,
      })
      rules.push({
        direction: 'long',
        protocol: 'pendle',
        baseSizePct: 3,
        baseConfidence: 0.6,
        urgency: 'medium',
        rationale: `Buy PT — rates expected to spike on ${impact.asset} freeze fear`,
      })
      break

    case 'interest_rate_change':
      // Rate increase → buy YT (yield tokens appreciate)
      // Rate decrease → buy PT (lock in current rate before it falls)
      rules.push({
        direction: isDecrease ? 'long' : 'long',
        protocol: 'pendle',
        baseSizePct: 3,
        baseConfidence: 0.5,
        urgency: 'medium',
        rationale: isDecrease
          ? `Rate decrease expected — buy PT to lock in current rate`
          : `Rate increase expected — buy YT to capture rising yield`,
      })
      break

    case 'asset_listing':
      // New asset listing → bullish demand signal
      rules.push({
        direction: 'long',
        protocol: 'spot',
        baseSizePct: 3,
        baseConfidence: 0.6,
        urgency: 'medium',
        rationale: `New asset listing for ${impact.asset} — demand increase expected`,
      })
      break

    case 'asset_delisting':
      rules.push({
        direction: 'short',
        protocol: 'dydx',
        baseSizePct: 5,
        baseConfidence: 0.8,
        urgency: 'high',
        rationale: `Asset delisting for ${impact.asset} — sell pressure expected`,
      })
      break

    case 'debt_ceiling_change':
      if (!isDecrease) {
        // Debt ceiling increase → protocol growth signal → long protocol token
        rules.push({
          direction: 'long',
          protocol: 'dydx',
          baseSizePct: 2,
          baseConfidence: 0.4,
          urgency: 'low',
          rationale: `Debt ceiling increase signals protocol growth`,
        })
      }
      break

    case 'dsr_change':
      // DSR change → significant macro DeFi event
      rules.push({
        direction: isDecrease ? 'short' : 'long',
        protocol: 'dydx',
        baseSizePct: 4,
        baseConfidence: 0.6,
        urgency: 'high',
        rationale: isDecrease
          ? `DSR decrease — reduced DAI demand expected`
          : `DSR increase — increased DAI demand expected`,
      })
      break

    case 'stability_fee_change':
      if (!isDecrease) {
        // Higher stability fees → potential deleverage → mixed signal
        rules.push({
          direction: 'short',
          protocol: 'dydx',
          baseSizePct: 2,
          baseConfidence: 0.4,
          urgency: 'low',
          rationale: `Stability fee increase may trigger CDP deleverage`,
        })
      }
      break
  }

  return rules
}

// ─── Signal Generation ──────────────────────────────────────────────

/**
 * Generate trade signals from a proposal analysis.
 */
export function generateSignals(
  analysis: ProposalAnalysis,
  currentPositions: Position[],
): TradeSignal[] {
  const signals: TradeSignal[] = []
  const stageConfidence = STAGE_CONFIDENCE[analysis.stage] ?? 0.1

  for (const impact of analysis.impacts) {
    // Determine if the change is a decrease
    const isDecrease = detectDecrease(impact)

    // Get applicable trade rules
    const rules = getTradeRules(impact, isDecrease)

    for (const rule of rules) {
      // Adjust confidence by governance stage
      const confidence = Math.min(rule.baseConfidence * stageConfidence * (1 + analysis.confidenceScore), 1)

      // Skip low-confidence signals
      if (confidence < 0.15) continue

      // Adjust size by confidence
      const sizePct = rule.baseSizePct * confidence

      // Check if we already have a position in this direction
      const existingPosition = currentPositions.find(
        (p) => p.asset === impact.asset && p.protocol === rule.protocol,
      )

      if (existingPosition) {
        log.debug(
          { asset: impact.asset, protocol: rule.protocol },
          'Position already exists — skipping duplicate signal',
        )
        continue
      }

      const signal: TradeSignal = {
        id: randomUUID(),
        asset: impact.asset,
        direction: rule.direction,
        sizePct,
        protocol: rule.protocol,
        confidence,
        rationale: rule.rationale,
        proposalId: analysis.proposalId,
        governanceStage: analysis.stage,
        timestamp: Date.now(),
        urgency: rule.urgency,
      }

      signals.push(signal)
      log.info(
        {
          asset: signal.asset,
          direction: signal.direction,
          protocol: signal.protocol,
          confidence: confidence.toFixed(3),
          sizePct: sizePct.toFixed(2),
          stage: analysis.stage,
        },
        'Generated trade signal',
      )
    }
  }

  return signals
}

/**
 * Detect whether a proposal impact represents a decrease in the parameter.
 */
function detectDecrease(impact: ProposalImpact): boolean {
  if (impact.currentValue && impact.proposedValue) {
    return parseFloat(impact.proposedValue) < parseFloat(impact.currentValue)
  }
  if (impact.delta) {
    return parseFloat(impact.delta) < 0
  }
  // Default: assume increase (conservative)
  return false
}

// ─── Event Bus Integration ──────────────────────────────────────────

/**
 * Wire the signal generator to the event bus.
 * Listens for analysis:proposal events and emits signal:trade events.
 */
export function wireSignalGenerator(getCurrentPositions: () => Position[]): void {
  eventBus.on('analysis:proposal', (analysis: ProposalAnalysis) => {
    const positions = getCurrentPositions()
    const signals = generateSignals(analysis, positions)

    for (const signal of signals) {
      eventBus.emit('signal:trade', signal)
    }
  })

  log.info('Signal generator wired to event bus')
}
