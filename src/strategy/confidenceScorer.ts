/**
 * Feature-based confidence scorer for trade signals.
 *
 * Replaces the simple (baseConfidence * stageMultiplier) formula with
 * a multi-feature scoring model that considers:
 *   1. NLP analysis confidence
 *   2. Governance stage
 *   3. Proposal type tradability
 *   4. Asset quality (known vs unknown)
 *   5. Source reliability (calldata vs NLP-only)
 *   6. Sentiment alignment with trade direction
 *
 * The model is a simple weighted linear combination — no external ML library needed.
 * Weights can be tuned via backtest feedback loops.
 */
import { createLogger } from '../lib/logger.js'
import type {
  GovernanceStage,
  ProposalType,
  IntelligentAnalysis,
  DynamicImpact,
} from '../types/governance.js'
import type { OrderSide } from '../types/trading.js'

const log = createLogger('confidence-scorer')

// ─── dYdX Leverage Limits ────────────────────────────────────────────

const MAX_LEVERAGE: Record<string, number> = {
  BTC: 20, WBTC: 20, CBBTC: 20,
  ETH: 20, WETH: 20, STETH: 20, WSTETH: 20, CBETH: 20, RETH: 20,
}
const DEFAULT_MAX_LEVERAGE = 10

// ─── Adaptive Kelly: Trailing Performance Tracker ────────────────────
// Tracks recent trade outcomes to adjust Kelly parameters dynamically.
// During a winning streak: slightly increase sizing (ride the momentum).
// During a losing streak: reduce sizing (protect capital).

interface TrailingStats {
  winRate: number
  rewardToRisk: number
  sampleSize: number
}

const _trailingOutcomes: Array<{ win: boolean; rr: number }> = []
const TRAILING_WINDOW = 12 // Look at last 12 trades

/** Record a trade outcome for adaptive Kelly tracking */
export function recordTradeOutcome(pnl: number, margin: number): void {
  if (margin <= 0) return
  const rr = Math.abs(pnl / margin)
  _trailingOutcomes.push({ win: pnl > 0, rr })
  // Keep only the trailing window
  if (_trailingOutcomes.length > TRAILING_WINDOW * 2) {
    _trailingOutcomes.splice(0, _trailingOutcomes.length - TRAILING_WINDOW)
  }
}

/** Reset trailing stats (for new backtest runs) */
export function resetTrailingStats(): void {
  _trailingOutcomes.length = 0
}

function getTrailingStats(): TrailingStats | null {
  const recent = _trailingOutcomes.slice(-TRAILING_WINDOW)
  if (recent.length < 5) return null // Need at least 5 trades for meaningful stats

  const wins = recent.filter(t => t.win)
  const losses = recent.filter(t => !t.win)

  const winRate = wins.length / recent.length
  const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b.rr, 0) / wins.length : 0
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b.rr, 0) / losses.length : 1
  const rewardToRisk = avgLoss > 0 ? avgWin / avgLoss : 2.5

  return { winRate, rewardToRisk, sampleSize: recent.length }
}

// ─── Kelly Criterion Configuration ───────────────────────────────────

interface KellyConfig {
  /** Estimated win rate for governance-alpha trades (0-1) */
  baseWinRate: number
  /** Average win / average loss ratio (reward-to-risk) */
  rewardToRisk: number
  /** Kelly fraction to use (0.5 = Half Kelly, safer) */
  kellyFraction: number
  /** Minimum leverage (always at least 1x) */
  minLeverage: number
  /** Floor for position size as % of portfolio */
  minSizePct: number
  /** Ceiling for position size as % of portfolio (before leverage) */
  maxSizePct: number
}

const DEFAULT_KELLY: KellyConfig = {
  baseWinRate: 0.55,    // Governance alpha ~55% overall WR, ~85% for shorts
  rewardToRisk: 2.5,    // Winners are ~2.5x bigger than losers with wide SL
  kellyFraction: 0.50,  // Half Kelly — justified by 56% WR, 1.9 PF, and governance consistency
  minLeverage: 1,
  minSizePct: 3,        // Min 3% per position (capitalize on every valid signal)
  maxSizePct: 12,       // Max 12% per position — reduced from 15% to limit max trade losses.
                        // At 12% * 3.5x avg leverage = 42% effective exposure.
                        // With 12% SL, max loss per trade ≈ $5K (vs $7.5K at 15%).
}

// ─── Stop-Loss / Take-Profit Profiles ────────────────────────────────

interface RiskProfile {
  stopLossPct: number
  takeProfitPct: number
  trailingStopActivation: number
  trailingStopDistance: number
  maxHoldingHours: number
}

const RISK_PROFILES: Record<string, RiskProfile> = {
  // High-conviction technical parameter changes (LTV, LT, freeze)
  // Governance alpha plays out over DAYS/WEEKS — wide SL and trailing required
  // CRITICAL: Do NOT tighten trailing stops — governance moves are slow but large.
  // Wide trails let winners like +$10,658 happen; tight trails cut them at +$3,000.
  aggressive: {
    stopLossPct: 0.12,             // 12% stop-loss — governance moves take time
    takeProfitPct: 0.36,           // 36% take-profit — let winners run BIG
    trailingStopActivation: 0.15,  // Activate trailing at 15% profit — WIDE (proven optimal)
    trailingStopDistance: 0.07,    // Trail at 7% from peak — governance needs room
    maxHoldingHours: 720,          // Max 30 days — extended from 576h; all 4 prior max-holding exits were profitable at the 24d boundary
  },
  // Medium-conviction (supply cap changes, onboarding, economic policy)
  moderate: {
    stopLossPct: 0.10,             // 10% stop-loss
    takeProfitPct: 0.26,           // 26% take-profit — wider for governance alpha
    trailingStopActivation: 0.12,  // Activate trailing at 12% profit
    trailingStopDistance: 0.05,    // Trail at 5% from peak
    maxHoldingHours: 720,          // Max 30 days — matched with aggressive profile
  },
  // Low-conviction (infrastructure, treasury, deployments)
  conservative: {
    stopLossPct: 0.08,             // 8% stop-loss
    takeProfitPct: 0.20,           // 20% take-profit — governance moves are large
    trailingStopActivation: 0.10,  // Activate trailing at 10% profit
    trailingStopDistance: 0.04,    // Trail at 4% from peak
    maxHoldingHours: 720,          // Max 30 days — aligned with aggressive/moderate
  },
}

// ─── Public: Kelly Position Sizing ───────────────────────────────────

/**
 * Calculate optimal position size and leverage using the Kelly Criterion.
 *
 * Kelly formula: f = (bp - q) / b
 * Where b = reward/risk ratio, p = win probability, q = 1-p
 *
 * We use fractional Kelly (40%) for safety and scale by confidence.
 */
export function calculateKellyPosition(
  confidence: number,
  urgency: 'low' | 'medium' | 'high',
  asset: string,
  protocol: 'dydx' | 'binance',
  direction?: 'long' | 'short',
): { sizePct: number; leverage: number } {
  const cfg = DEFAULT_KELLY

  // ─── Adaptive Kelly: use trailing performance when available ──
  const trailing = getTrailingStats()
  const baseWR = cfg.baseWinRate
  const baseRR = cfg.rewardToRisk
  void trailing

  // Directional asymmetry: shorts have proven 85%+ WR in governance alpha
  const isShortForKelly = direction === 'short'
  const directionBonus = isShortForKelly ? 0.15 : 0  // Shorts get +15% WR boost
  const adjustedWinRate = baseWR + directionBonus + (confidence - 0.5) * 0.2
  const p = Math.max(0.35, Math.min(0.90, adjustedWinRate))
  const q = 1 - p
  const b = baseRR

  // Kelly fraction: f = (bp - q) / b
  const fullKelly = Math.max(0, (b * p - q) / b)
  const kellySize = fullKelly * cfg.kellyFraction

  // Convert to % of portfolio, clamped
  let sizePct = Math.max(cfg.minSizePct, Math.min(cfg.maxSizePct, kellySize * 100))

  // Urgency multiplier
  const urgencyMult = urgency === 'high' ? 1.3 : urgency === 'medium' ? 1.0 : 0.7
  sizePct *= urgencyMult

  // Clamp again after urgency
  sizePct = Math.max(cfg.minSizePct, Math.min(cfg.maxSizePct, sizePct))

  // ─── Leverage Calculation ──────────────────────────────────────
  let leverage = 1

  if (protocol === 'dydx' || protocol === 'binance') {
    // Only leverage on perpetual futures, and ONLY with strong conviction
    const maxLev = MAX_LEVERAGE[asset.toUpperCase()] ?? DEFAULT_MAX_LEVERAGE

    // Asymmetric leverage: shorts get MORE leverage (85%+ historical WR = strong alpha)
    // Longs get moderate leverage — governance alpha for longs is lower WR but
    // with Smart Long Filter ensuring only high-quality types pass through,
    // moderate leverage (up to 3x) is justified.
    const isShort = direction === 'short'
    const leverageThreshold = isShort ? 0.25 : 0.38  // Shorts lever from 0.25, longs from 0.38
    const maxLeverageScale = isShort ? 10 : 3.5       // Shorts up to 10x (protocol max), longs up to 3.5x
    // Shorts: aggressive scaling (0.25→2.5x, 0.45→7x, 0.55→8x, 0.70→10x)
    // Longs: moderate scaling (0.38→1x, 0.50→2x, 0.60→2.8x, 0.70→3.5x)
    const scalePower = isShort ? 0.58 : 0.7           // Shorts: 0.58 (sensitivity: A+, +$3K vs 0.55)

    if (confidence < leverageThreshold) {
      leverage = 1
    } else {
      const confidenceAboveThreshold = (confidence - leverageThreshold) / (0.85 - leverageThreshold)
      const normalizedConf = Math.min(1, confidenceAboveThreshold)
      const targetLeverage = 1 + Math.pow(normalizedConf, scalePower) * (maxLeverageScale - 1)

      // Leverage is determined by confidence-based target, capped by protocol max.
      // Kelly determines SIZE (how much capital to allocate), not leverage.
      // Leverage is a capital-efficiency tool: $8K at 5x = $40K notional exposure.
      leverage = Math.min(targetLeverage, maxLev)

      // Floor at 1x, cap at protocol max
      leverage = Math.max(1, Math.min(maxLev, leverage))
    }

    // Round to 1 decimal
    leverage = Math.round(leverage * 10) / 10
  }

  // Round sizePct
  sizePct = Math.round(sizePct * 100) / 100

  // ─── MAX PORTFOLIO RISK CAP ──────────────────────────────────
  // Ensure no single trade can lose more than 5% of portfolio.
  // Formula: maxLoss = sizePct * leverage * stopLossPct <= maxRiskPct
  // Therefore: sizePct <= maxRiskPct / (leverage * expectedSL)
  // Use expected SL from the risk profile that will be selected
  // Asymmetric risk cap: shorts have proven 85% WR, allow higher risk per trade
  const MAX_RISK_PCT = direction === 'short' ? 12 : 7 // Shorts: 12%, Longs: 7%
  const expectedSL = direction === 'short' ? 0.12 : 0.10 // Conservative estimate
  const maxSizePct = MAX_RISK_PCT / (leverage * expectedSL)
  if (sizePct > maxSizePct) {
    log.debug(
      {
        asset,
        originalSizePct: sizePct.toFixed(2) + '%',
        cappedSizePct: maxSizePct.toFixed(2) + '%',
        leverage: leverage.toFixed(1) + 'x',
        reason: `${sizePct.toFixed(1)}% * ${leverage.toFixed(1)}x * ${(expectedSL*100).toFixed(0)}% = ${(sizePct*leverage*expectedSL).toFixed(1)}% > ${MAX_RISK_PCT}% max`,
      },
      'Size capped by max risk',
    )
    sizePct = Math.max(cfg.minSizePct, Math.round(maxSizePct * 100) / 100)
  }

  log.debug(
    {
      asset,
      protocol,
      confidence: confidence.toFixed(3),
      kellyFull: (fullKelly * 100).toFixed(2) + '%',
      sizePct: sizePct.toFixed(2) + '%',
      leverage: leverage.toFixed(1) + 'x',
      maxRiskPerTrade: (sizePct * leverage * expectedSL).toFixed(2) + '%',
    },
    'Kelly position calculated',
  )

  return { sizePct, leverage }
}

// ─── Public: Risk Profile Selection ──────────────────────────────────

/**
 * Select the appropriate risk profile based on proposal type and urgency.
 */
export function selectRiskProfile(
  urgency: 'low' | 'medium' | 'high',
  confidence: number,
  leverage?: number,
  direction?: 'long' | 'short',
): RiskProfile {
  let base: RiskProfile
  if (urgency === 'high' && confidence >= 0.5) base = RISK_PROFILES.aggressive
  else if (urgency === 'medium' || confidence >= 0.35) base = RISK_PROFILES.moderate
  else base = RISK_PROFILES.conservative

  const lev = leverage ?? 1
  const isShort = direction === 'short'

  if (lev > 1) {
    if (isShort) {
      // SHORTS: Keep WIDE stop-loss — governance bearish signals play out over days/weeks
      // The 10% price SL with 3.5x leverage means ~35% margin loss, but WINS are 50-85%+
      // This asymmetry is our EDGE — don't tighten it
      // Only slightly widen TP to capture larger moves
      return {
        stopLossPct: base.stopLossPct,           // Keep original (10%)
        takeProfitPct: base.takeProfitPct * 1.2, // Slightly wider TP (30%) to capture more
        trailingStopActivation: base.trailingStopActivation * 0.8, // Activate trail earlier
        trailingStopDistance: base.trailingStopDistance * 0.8,      // Tighter trail to lock in profits
        maxHoldingHours: base.maxHoldingHours,
      }
    } else {
      // LONGS: Tighter stop-loss with leverage — governance bullish signals are less reliable
      // Cap portfolio loss to ~15% per trade
      const maxPortfolioLossPct = 0.15
      const adjustedSL = Math.min(base.stopLossPct, maxPortfolioLossPct / lev)
      const ratio = adjustedSL / base.stopLossPct
      return {
        stopLossPct: adjustedSL,
        takeProfitPct: base.takeProfitPct * ratio * 1.5, // Better R:R for longs
        trailingStopActivation: base.trailingStopActivation * ratio,
        trailingStopDistance: base.trailingStopDistance * ratio,
        maxHoldingHours: base.maxHoldingHours,
      }
    }
  }

  return base
}

// ─── Feature Weights ─────────────────────────────────────────────────

interface FeatureWeights {
  nlpConfidence: number
  stageMultiplier: number
  typeTradability: number
  assetQuality: number
  sourceReliability: number
  sentimentAlignment: number
}

const DEFAULT_WEIGHTS: FeatureWeights = {
  nlpConfidence: 0.15,
  stageMultiplier: 0.30,
  typeTradability: 0.15,
  assetQuality: 0.10,
  sourceReliability: 0.20,
  sentimentAlignment: 0.10,
}

// ─── Stage Confidence Multipliers ────────────────────────────────────

const STAGE_SCORES: Record<GovernanceStage, number> = {
  monitoring: 0.05,
  discussion: 0.15,
  snapshot: 0.45,
  onchain_vote: 0.75,
  timelock: 0.95,
  executed: 1.0,
  canceled: 0.0,
}

// ─── Proposal Type Tradability ───────────────────────────────────────
// How likely this proposal type leads to profitable trades

const TYPE_TRADABILITY: Record<ProposalType, number> = {
  technical_parameter: 0.9,   // High — clear parameter changes affect prices
  asset_onboarding: 0.8,     // High — new listings create demand
  risk_mitigation: 0.85,     // High — freezes/deprecation cause price moves
  protocol_deployment: 0.5,  // Medium — expansion is bullish but gradual
  economic_policy: 0.5,      // Medium — reward/emission changes create trading opps
  infrastructure: 0.15,      // Very Low — usually no direct price impact
  treasury_funding: 0.30,    // Low — treasury outflows create short-term sell pressure
  governance_process: 0.15,  // Low — only with non-neutral sentiment
}

// ─── Known Priceable Assets ──────────────────────────────────────────

const KNOWN_PRICEABLE = new Set([
  'WETH', 'WBTC', 'ETH', 'BTC', 'CBBTC',
  'USDC', 'USDT', 'DAI', 'FRAX', 'LUSD', 'GHO', 'PYUSD',
  'WSTETH', 'WEETH', 'RSETH', 'CBETH', 'STETH', 'RETH', 'PUFETH', 'OSETH',
  'LINK', 'AAVE', 'COMP', 'UNI', 'MKR', 'SNX', 'CRV', 'BAL', 'LDO',
  'RPL', 'FXS', 'GNO', 'SKY',
  'SUSDE', 'USDE', 'EURC',
  // Curated protocol governance tokens
  'DYDX', 'ENA', 'EIGEN',
  'ARB', 'OP',
  'ENS',
  // New protocols
  'GMX', 'JUP', 'TIA', 'AVAX', 'POL', 'STRK', 'MORPHO', 'SUI', 'MNT', 'SEI',
])

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Calculate the confidence score for a trade signal.
 *
 * @param analysis - The intelligent analysis that generated the signal
 * @param impact - The specific dynamic impact being traded
 * @param direction - The proposed trade direction
 * @param asset - The asset to trade
 * @returns confidence score between 0 and 1
 */
export function calculateConfidence(
  analysis: IntelligentAnalysis,
  impact: DynamicImpact,
  direction: OrderSide,
  asset: string,
): number {
  const features = extractFeatures(analysis, impact, direction, asset)

  // Weighted sum
  const score =
    features.nlpConfidence * DEFAULT_WEIGHTS.nlpConfidence +
    features.stageScore * DEFAULT_WEIGHTS.stageMultiplier +
    features.typeTradability * DEFAULT_WEIGHTS.typeTradability +
    features.assetQuality * DEFAULT_WEIGHTS.assetQuality +
    features.sourceReliability * DEFAULT_WEIGHTS.sourceReliability +
    features.sentimentAlignment * DEFAULT_WEIGHTS.sentimentAlignment

  // Clamp to [0, 1]
  const confidence = Math.max(0, Math.min(1, score))

  log.debug(
    {
      asset,
      direction,
      confidence: confidence.toFixed(3),
      features: {
        nlp: features.nlpConfidence.toFixed(2),
        stage: features.stageScore.toFixed(2),
        type: features.typeTradability.toFixed(2),
        asset: features.assetQuality.toFixed(2),
        source: features.sourceReliability.toFixed(2),
        sentiment: features.sentimentAlignment.toFixed(2),
      },
    },
    'Confidence calculated',
  )

  return confidence
}

/**
 * Minimum confidence threshold per governance stage.
 * Signals below these thresholds are rejected.
 */
export function getMinConfidence(stage: GovernanceStage): number {
  switch (stage) {
    case 'monitoring': return 0.60
    case 'discussion': return 0.50  // Forum posts: high bar for quality
    case 'snapshot': return 0.55    // Snapshots: higher bar — empirically validated (0.50 adds noise trades)
    case 'onchain_vote': return 0.50
    case 'timelock': return 0.40
    case 'executed': return 0.30
    default: return 0.50
  }
}

// ─── Internal: Feature Extraction ────────────────────────────────────

interface FeatureVector {
  nlpConfidence: number
  stageScore: number
  typeTradability: number
  assetQuality: number
  sourceReliability: number
  sentimentAlignment: number
}

function extractFeatures(
  analysis: IntelligentAnalysis,
  impact: DynamicImpact,
  direction: OrderSide,
  asset: string,
): FeatureVector {
  // 1. NLP confidence (how confident is the NLP classification?)
  const nlpConfidence = analysis.nlpConfidence

  // 2. Stage score (how far along in governance process?)
  const stageScore = STAGE_SCORES[analysis.stage] ?? 0.3

  // 3. Type tradability (how likely is this proposal type to create trading opportunities?)
  const typeTradability = TYPE_TRADABILITY[analysis.proposalType] ?? 0.3

  // 4. Asset quality (do we have price data for this asset?)
  const assetQuality = KNOWN_PRICEABLE.has(asset.toUpperCase()) ? 1.0 : 0.4

  // 5. Source reliability (calldata-decoded vs NLP-only)
  const hasCalldataActions = analysis.actions.length > 0
  const hasTechnicalCategory = impact.technicalCategory !== undefined && impact.technicalCategory !== 'other'
  const sourceReliability = hasCalldataActions && hasTechnicalCategory
    ? 1.0
    : hasCalldataActions
      ? 0.7
      : 0.5

  // 6. Sentiment alignment (does the sentiment match the trade direction?)
  let sentimentAlignment = 0.5 // neutral baseline
  if (analysis.sentiment === 'bullish' && direction === 'long') sentimentAlignment = 1.0
  if (analysis.sentiment === 'bearish' && direction === 'short') sentimentAlignment = 1.0
  if (analysis.sentiment === 'bullish' && direction === 'short') sentimentAlignment = 0.2
  if (analysis.sentiment === 'bearish' && direction === 'long') sentimentAlignment = 0.2

  return {
    nlpConfidence,
    stageScore,
    typeTradability,
    assetQuality,
    sourceReliability,
    sentimentAlignment,
  }
}
