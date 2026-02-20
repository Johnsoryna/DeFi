/**
 * Signal generator — dynamic strategy engine.
 *
 * Converts ProposalAnalysis / IntelligentAnalysis → TradeSignal[].
 *
 * The system supports two paths:
 *   1. Dynamic path: IntelligentAnalysis with dynamicImpacts → DynamicTradeStrategy
 *   2. Legacy path: ProposalAnalysis with ProposalImpact[] → fixed ImpactCategory rules
 *
 * The dynamic path is used when the Intelligence Engine produces the analysis.
 * The legacy path is kept for backward compatibility with old-format analyses.
 */
import { randomUUID } from 'node:crypto'
import { eventBus } from '../lib/eventBus.js'
import { createLogger } from '../lib/logger.js'
import { getClock } from '../backtest/clock.js'
import { STABLECOINS } from '../config/addresses.js'
import { calculateConfidence, getMinConfidence, calculateKellyPosition, selectRiskProfile } from './confidenceScorer.js'
import { getDrawdownFromHigh, getShortTermMomentum, getMomentum, hasEthVReversal, getPriceService } from './priceService.js'
import type {
  ProposalAnalysis,
  ProposalImpact,
  GovernanceStage,
  IntelligentAnalysis,
  DynamicImpact,
  ProposalType,
} from '../types/governance.js'
import type { TradeSignal, OrderSide, ExecutionProtocol, Position } from '../types/trading.js'

const log = createLogger('signal-gen')


/** Parse a float safely, returning 0 for NaN/non-numeric strings */
function safeParseFloat(value: string | undefined): number {
  const n = parseFloat(value || '0')
  return Number.isFinite(n) ? n : 0
}

// ─── Type Guard ──────────────────────────────────────────────────────

function isIntelligentAnalysis(analysis: ProposalAnalysis): analysis is IntelligentAnalysis {
  return 'dynamicImpacts' in analysis && Array.isArray((analysis as IntelligentAnalysis).dynamicImpacts)
}

// ─── Dynamic Trade Strategy Matrix ───────────────────────────────────

interface DynamicStrategy {
  proposalType: ProposalType
  generateSignals: (
    impact: DynamicImpact,
    analysis: IntelligentAnalysis,
  ) => Array<{ asset: string; direction: OrderSide; protocol: ExecutionProtocol; sizePct: number; urgency: 'low' | 'medium' | 'high'; rationale: string }>
}

/**
 * Strategy matrix for each proposal type.
 * Each strategy defines HOW to generate trade signals from a dynamic impact.
 */
const STRATEGY_MATRIX: DynamicStrategy[] = [
  // ─── Technical Parameter Changes ─────────────────────────────
  {
    proposalType: 'technical_parameter',
    generateSignals: (impact, analysis) => {
      const signals: Array<{ asset: string; direction: OrderSide; protocol: ExecutionProtocol; sizePct: number; urgency: 'low' | 'medium' | 'high'; rationale: string }> = []

      // Determine direction using multiple sources (not just sentiment)
      // 1. Strongest: expectedPriceImpact from NLP/classifier
      // 2. Sentiment as fallback
      // 3. If truly unknown: skip (return empty)
      let isDecrease: boolean
      if (impact.expectedPriceImpact === 'negative' || impact.expectedPriceImpact === 'strong_negative') {
        isDecrease = true
      } else if (impact.expectedPriceImpact === 'positive' || impact.expectedPriceImpact === 'strong_positive') {
        isDecrease = false
      } else if (analysis.sentiment === 'bearish') {
        isDecrease = true
      } else if (analysis.sentiment === 'bullish') {
        isDecrease = false
      } else {
        // Neutral price impact + neutral sentiment → skip, don't guess
        log.debug(
          { type: impact.type, assets: impact.affectedAssets },
          'Dynamic signal skipped: direction unknown (neutral sentiment + neutral price impact)',
        )
        return signals
      }

      // Canonical stablecoin set from config
      const STABLES_TECH = STABLECOINS

      for (const asset of impact.affectedAssets) {
        const cat = impact.technicalCategory
        const isStablecoin = STABLES_TECH.has(asset.toUpperCase())

        if (cat === 'ltv_change' || cat === 'liquidation_threshold_change') {
          // If asset is a stablecoin, redirect to governance token with lower conviction
          const tradeAsset = isStablecoin ? (getGovTokenForAsset(asset, impact.affectedProtocols) || asset) : asset
          const tradeSize = isStablecoin ? 3 : (isDecrease ? 5 : 3)
          const tradeUrgency = isStablecoin ? 'medium' as const : 'high' as const
          signals.push({
            asset: tradeAsset,
            direction: isDecrease ? 'short' : 'long',
            protocol: 'binance',
            sizePct: tradeSize,
            urgency: tradeUrgency,
            rationale: isDecrease
              ? `LT/LTV decrease on ${asset} — liquidation cascade risk`
              : `LT/LTV increase on ${asset} — unlocks borrowing capacity`,
          })
        } else if (cat === 'supply_cap_change' || cat === 'borrow_cap_change') {
          // Cap changes: trade the GOVERNANCE TOKEN (not the asset itself)
          // Cap decrease = risk concerns → short gov token; increase = growth → long gov token
          const govToken = getGovTokenForAsset(asset, impact.affectedProtocols)
          if (govToken) {
            signals.push({
              asset: govToken,
              direction: isDecrease ? 'short' : 'long',
              protocol: 'binance',
              sizePct: 2,
              urgency: 'medium',
              rationale: isDecrease
                ? `Cap decrease on ${asset} signals risk concerns — bearish for ${govToken}`
                : `Cap increase on ${asset} signals growth — bullish for ${govToken}`,
            })
          }
        } else if (cat === 'interest_rate_change') {
          // Interest rate changes → trade the governance token
          const govToken = getGovTokenForAsset(asset, impact.affectedProtocols)
          if (govToken) {
            signals.push({
              asset: govToken,
              direction: isDecrease ? 'short' : 'long',
              protocol: 'binance',
              sizePct: 2,
              urgency: 'medium',
              rationale: isDecrease
                ? `Rate decrease — may reduce protocol revenue → bearish for ${govToken}`
                : `Rate increase — may increase protocol revenue → bullish for ${govToken}`,
            })
          }
        } else if (cat === 'reserve_freeze') {
          signals.push({
            asset,
            direction: 'short',
            protocol: 'binance',
            sizePct: 5,
            urgency: 'high',
            rationale: `Reserve freeze on ${asset} — flight to safety`,
          })
        } else if (cat === 'dsr_change') {
          // DAI is a stablecoin — DSR changes affect demand but DAI stays pegged
          // In practice, insufficient price movement for profitable directional trades
          // Instead trade the governance token (SKY — MKR migrated to SKY, MKR-USD delisted on dYdX)
          signals.push({
            asset: 'SKY',
            direction: isDecrease ? 'short' : 'long',
            protocol: 'binance',
            sizePct: 3,
            urgency: 'high',
            rationale: isDecrease
              ? `DSR decrease — reduced DAI demand → bearish for SKY`
              : `DSR increase — increased DAI demand → bullish for SKY`,
          })
        } else if (cat === 'debt_ceiling_change' && !isDecrease) {
          signals.push({
            asset,
            direction: 'long',
            protocol: 'binance',
            sizePct: 2,
            urgency: 'low',
            rationale: `Debt ceiling increase signals protocol growth`,
          })
        } else if (cat === 'emode_change') {
          signals.push({
            asset,
            direction: 'long',
            protocol: 'binance',
            sizePct: 2,
            urgency: 'medium',
            rationale: `E-Mode change may improve capital efficiency for ${asset}`,
          })
        } else {
          // Generic technical parameter → trade the governance token
          const govToken = getGovTokenForAsset(asset, impact.affectedProtocols)
          if (govToken) {
            signals.push({
              asset: govToken,
              direction: isDecrease ? 'short' : 'long',
              protocol: 'binance',
              sizePct: 2,
              urgency: 'low',
              rationale: `Technical parameter ${isDecrease ? 'decrease' : 'increase'} on ${asset} — ${isDecrease ? 'bearish' : 'bullish'} for ${govToken}`,
            })
          }
        }
      }
      return signals
    },
  },

  // ─── Asset Onboarding ────────────────────────────────────────
  {
    proposalType: 'asset_onboarding',
    generateSignals: (impact, _analysis) => {
      const signals: Array<{ asset: string; direction: OrderSide; protocol: ExecutionProtocol; sizePct: number; urgency: 'low' | 'medium' | 'high'; rationale: string }> = []

      // New asset onboarding → LONG the governance token (protocol growth signal)
      // Don't trade the onboarded asset itself (market prices in before on-chain)
      for (const protocol of impact.affectedProtocols) {
        const govToken = PROTOCOL_GOV_TOKEN[protocol]
        if (govToken) {
          signals.push({
            asset: govToken,
            direction: 'long',
            protocol: 'binance',
            sizePct: 3,
            urgency: 'medium',
            rationale: `New asset onboarding increases TVL & utility — bullish for ${govToken}`,
          })
        }
      }

      return signals
    },
  },

  // ─── Protocol Deployment ─────────────────────────────────────
  {
    proposalType: 'protocol_deployment',
    generateSignals: (impact, _analysis) => {
      const signals: Array<{ asset: string; direction: OrderSide; protocol: ExecutionProtocol; sizePct: number; urgency: 'low' | 'medium' | 'high'; rationale: string }> = []

      // Protocol expansion to new chains → LONG the governance token
      for (const protocol of impact.affectedProtocols) {
        const govToken = PROTOCOL_GOV_TOKEN[protocol]
        if (govToken) {
          signals.push({
            asset: govToken,
            direction: 'long',
            protocol: 'binance',
            sizePct: 3,
            urgency: 'medium',
            rationale: `Protocol deployment expands ecosystem reach — bullish for ${govToken}`,
          })
        }
      }

      return signals
    },
  },

  // ─── Risk Mitigation ─────────────────────────────────────────
  {
    proposalType: 'risk_mitigation',
    generateSignals: (impact, analysis) => {
      const signals: Array<{ asset: string; direction: OrderSide; protocol: ExecutionProtocol; sizePct: number; urgency: 'low' | 'medium' | 'high'; rationale: string }> = []

      // Canonical stablecoin set — if affected asset is a stablecoin, short the GOVERNANCE TOKEN instead
      const STABLES = STABLECOINS

      for (const asset of impact.affectedAssets) {
        if (STABLES.has(asset.toUpperCase())) {
          // Stablecoin deprecation/freeze → short the governance token (stablecoin itself won't move)
          // Keep SAME conviction as direct shorts — wider SL (aggressive) lets trades survive volatility
          const govToken = getGovTokenForAsset(asset, impact.affectedProtocols)
          if (govToken) {
            signals.push({
              asset: govToken,
              direction: 'short',
              protocol: 'binance',
              sizePct: 5,
              urgency: 'high',  // Keep aggressive risk profile (wider 12% SL needed for governance alpha)
              rationale: `Risk mitigation on stablecoin ${asset} — bearish for ${govToken} (protocol risk)`,
            })
          }
        } else {
          // Cross-protocol leakage guard: if the affected asset belongs to a DIFFERENT
          // protocol than the proposal's source, the proposal doesn't impair the asset
          // itself — it only affects the proposing protocol.
          // e.g. dYdX "Delist MKR-USD" → don't short SKY (Maker); short DYDX instead.
          const assetHome = ASSET_PROTOCOL[asset.toUpperCase()]
          if (assetHome && assetHome !== analysis.protocol) {
            const proposalGovToken = PROTOCOL_GOV_TOKEN[analysis.protocol]
            if (proposalGovToken) {
              signals.push({
                asset: proposalGovToken,
                direction: 'short',
                protocol: 'binance',
                sizePct: 4,  // Lower conviction — indirect signal via cross-protocol mention
                urgency: 'medium',
                rationale: `Risk mitigation: ${analysis.protocol} delisting/restricting ${asset} — bearish for ${proposalGovToken} (reduced trading activity)`,
              })
            }
          } else {
            // Short affected asset — deprecation/freeze creates sell pressure
            // This is our STRONGEST alpha signal (85%+ historical WR) — max conviction
            signals.push({
              asset,
              direction: 'short',
              protocol: 'binance',
              sizePct: 6,  // Higher size for proven alpha
              urgency: 'high',
              rationale: `Risk mitigation: ${asset} may face reduced utility or exit pressure`,
            })
          }
        }
      }

      // If it's a v2 deprecation, could be bullish for v3 → long governance token
      if (analysis.title.toLowerCase().includes('v2') && analysis.title.toLowerCase().includes('deprecat')) {
        for (const protocol of impact.affectedProtocols) {
          const govToken = PROTOCOL_GOV_TOKEN[protocol]
          if (govToken) {
            signals.push({
              asset: govToken,
              direction: 'long',
              protocol: 'binance',
              sizePct: 2,
              urgency: 'low',
              rationale: `v2 deprecation may drive migration to v3 — bullish for protocol`,
            })
          }
        }
      }

      return signals
    },
  },

  // ─── Economic Policy ─────────────────────────────────────────
  {
    proposalType: 'economic_policy',
    generateSignals: (impact, analysis) => {
      const signals: Array<{ asset: string; direction: OrderSide; protocol: ExecutionProtocol; sizePct: number; urgency: 'low' | 'medium' | 'high'; rationale: string }> = []

      // Emissions/incentives changes → trade governance token via dYdX
      // Only trade if sentiment is clear (bullish or bearish), skip neutral
      if (analysis.sentiment === 'neutral') return signals

      for (const protocol of impact.affectedProtocols) {
        const govToken = PROTOCOL_GOV_TOKEN[protocol]
        if (govToken) {
          const isBullish = analysis.sentiment === 'bullish'
          signals.push({
            asset: govToken,
            direction: isBullish ? 'long' : 'short',
            protocol: 'binance',
            sizePct: 3,
            urgency: 'medium',
            rationale: isBullish
              ? `Economic policy may increase staking rewards / token utility`
              : `Emission reduction may decrease token attractiveness`,
          })
        }
      }

      return signals
    },
  },

  // ─── Infrastructure ──────────────────────────────────────────
  {
    proposalType: 'infrastructure',
    generateSignals: (impact, analysis) => {
      const signals: Array<{ asset: string; direction: OrderSide; protocol: ExecutionProtocol; sizePct: number; urgency: 'low' | 'medium' | 'high'; rationale: string }> = []

      // Infrastructure changes with clear sentiment → trade governance token
      if (analysis.sentiment !== 'neutral') {
        for (const protocol of impact.affectedProtocols) {
          const govToken = PROTOCOL_GOV_TOKEN[protocol]
          if (govToken) {
            signals.push({
              asset: govToken,
              direction: analysis.sentiment === 'bullish' ? 'long' : 'short',
              protocol: 'binance',
              sizePct: 2,
              urgency: 'low',
              rationale: `Infrastructure ${analysis.sentiment === 'bullish' ? 'improvement' : 'concern'} — ${analysis.sentiment} for ${govToken}`,
            })
          }
        }
      }

      return signals
    },
  },

  // ─── Treasury Funding ────────────────────────────────────────
  {
    proposalType: 'treasury_funding',
    generateSignals: (impact, analysis) => {
      const signals: Array<{ asset: string; direction: OrderSide; protocol: ExecutionProtocol; sizePct: number; urgency: 'low' | 'medium' | 'high'; rationale: string }> = []

      // Treasury spending with clear sentiment → trade governance token
      if (analysis.sentiment !== 'neutral') {
        for (const protocol of impact.affectedProtocols) {
          const govToken = PROTOCOL_GOV_TOKEN[protocol]
          if (govToken) {
            signals.push({
              asset: govToken,
              direction: analysis.sentiment === 'bullish' ? 'long' : 'short',
              protocol: 'binance',
              sizePct: 2,
              urgency: 'low',
              rationale: `Treasury ${analysis.sentiment === 'bullish' ? 'investment' : 'drain'} — ${analysis.sentiment} for ${govToken}`,
            })
          }
        }
      }

      return signals
    },
  },

  // ─── Governance Process ──────────────────────────────────────
  {
    proposalType: 'governance_process',
    generateSignals: (impact, analysis) => {
      const signals: Array<{ asset: string; direction: OrderSide; protocol: ExecutionProtocol; sizePct: number; urgency: 'low' | 'medium' | 'high'; rationale: string }> = []

      // Governance process with clear sentiment → trade governance token
      if (analysis.sentiment !== 'neutral') {
        for (const protocol of impact.affectedProtocols) {
          const govToken = PROTOCOL_GOV_TOKEN[protocol]
          if (govToken) {
            signals.push({
              asset: govToken,
              direction: analysis.sentiment === 'bullish' ? 'long' : 'short',
              protocol: 'binance',
              sizePct: 2,
              urgency: 'low',
              rationale: `Governance process signal — ${analysis.sentiment} for ${govToken}`,
            })
          }
        }
      }
      return signals
    },
  },
]

// ─── Protocol → Governance Token Lookup ──────────────────────────────

const PROTOCOL_GOV_TOKEN: Record<string, string> = {
  aave: 'AAVE',
  compound: 'COMP',
  uniswap: 'UNI',
  maker: 'SKY',        // MKR migrated to SKY; MKR-USD delisted on dYdX
  lido: 'LDO',
  arbitrum: 'ARB',
  curve: 'CRV',
  // synthetix: REMOVED — snxgov.eth Snapshot noise; 50% WR, -$2,212 backtest. No forum source.
  convex: 'CVX',
  yearn: 'YFI',
  optimism: 'OP',
  dydx: 'DYDX',
  ethena: 'ENA',
  eigenlayer: 'EIGEN',
  ens: 'ENS',
  // ─── New Protocols ─────────────────────────────────────────
  gmx: 'GMX',
  jupiter: 'JUP',
  celestia: 'TIA',
  avalanche: 'AVAX',
  polygon: 'POL',
  starknet: 'STRK',
  morpho: 'MORPHO',
  sui: 'SUI',
  mantle: 'MNT',
  sei: 'SEI',
  // ─── Forum-active L1/L2 protocols (245 / 183 posts in DB) ───────
  near: 'NEAR',
  zksync: 'ZK',
}

// Asset → Protocol mapping (which protocol manages this asset)
const ASSET_PROTOCOL: Record<string, string> = {
  AAVE: 'aave', WETH: 'aave', WBTC: 'aave', WSTETH: 'aave', CBBTC: 'aave',
  LINK: 'aave', GHO: 'aave', RETH: 'aave', CBETH: 'aave', USDE: 'aave',
  COMP: 'compound', UNI: 'uniswap',
  MKR: 'maker', DAI: 'maker', SKY: 'maker',
  LDO: 'lido', STETH: 'lido',
  // Note: WSTETH already mapped to 'aave' (primary collateral context)
  ARB: 'arbitrum',
  CRV: 'curve',
  OP: 'optimism',
  CVX: 'convex',
  YFI: 'yearn',
  DYDX: 'dydx',
  ENA: 'ethena',
  EIGEN: 'eigenlayer',
  ENS: 'ens',
  // ─── New Protocol Assets ──────────────────────────────────
  GMX: 'gmx',
  JUP: 'jupiter',
  TIA: 'celestia',
  AVAX: 'avalanche',
  POL: 'polygon',
  STRK: 'starknet',
  MORPHO: 'morpho',
  SUI: 'sui',
  MNT: 'mantle',
  SEI: 'sei',
  NEAR: 'near',
  ZK: 'zksync',
}

// ─── Tradeable Asset Whitelist ────────────────────────────────────────
// Only trade assets that belong to our curated protocol list.
// The NLP engine extracts tokens from proposal text, which may include
// tokens we don't monitor (e.g. 1INCH mentioned in a Compound proposal).
// Without this filter, the bot trades unmonitored assets with no governance
// data — creating noise trades that appear profitable in backtest
// but have no live alpha source.
const TRADEABLE_ASSETS = new Set([
  // All assets in ASSET_PROTOCOL + governance tokens from PROTOCOL_GOV_TOKEN
  ...Object.keys(ASSET_PROTOCOL).map(a => a.toUpperCase()),
  ...Object.values(PROTOCOL_GOV_TOKEN).map(t => t.toUpperCase()),
])

// ─── Protocol Confidence ─────────────────────────────────────────────
// All monitored protocols are now "established" — they were curated based on:
//   1. Active governance with risk-events (parameter changes, freezes, etc.)
//   2. Active Binance perpetual market for the governance token
//   3. Discourse forum or Snapshot space for early signal detection
//   4. Sufficient Binance liquidity for realistic execution
const ESTABLISHED_PROTOCOLS = new Set([
  'aave', 'compound', 'uniswap', 'maker',
  'lido', 'arbitrum', 'optimism',
  'dydx', 'ethena', 'eigenlayer', 'ens',
  // ─── Re-enabled with improved strategy (direction-asymmetric + short bias) ──
  'curve', 'convex', 'yearn',
  // synthetix: REMOVED — snxgov.eth Snapshot proposals generate noise trades
  // ─── New Protocols ─────────────────────────────────────────
  'gmx', 'jupiter', 'celestia', 'avalanche', 'polygon',
  'starknet', 'morpho', 'sui', 'mantle', 'sei',
  'near', 'zksync',
])

// Protocols with historically weak governance alpha requiring elevated signal quality.
// Backtest evidence: morpho 6 trades, 33% WR, -$14,231 over Jan 2025–Feb 2026.
// NLP over-classifies morpho forum posts as actionable — raise bar significantly.
const WEAK_ALPHA_PROTOCOLS = new Set(['morpho'])

/**
 * Get protocol-specific minimum confidence.
 * Weak-alpha protocols require a higher threshold to filter noisy signals.
 */
function getProtocolMinConfidence(protocols: string[]): number {
  // Weak alpha: require strong signals only (33% WR backtest evidence)
  if (protocols.some(p => WEAK_ALPHA_PROTOCOLS.has(p))) return 0.65
  // All other established protocols: defer to stage-based minimum
  if (protocols.some(p => ESTABLISHED_PROTOCOLS.has(p))) return 0
  // Unknown protocol (shouldn't happen with curated list) — require strong conviction
  return 0.50
}

/** Get the governance token to trade for a given asset */
function getGovTokenForAsset(asset: string, protocols: string[]): string | null {
  // First try from the protocols list
  for (const protocol of protocols) {
    const govToken = PROTOCOL_GOV_TOKEN[protocol]
    if (govToken) return govToken
  }
  // Fallback: infer protocol from asset
  const protocol = ASSET_PROTOCOL[asset.toUpperCase()]
  if (protocol) return PROTOCOL_GOV_TOKEN[protocol] ?? null
  return null
}

// ─── Legacy: Governance Stage Confidence (for old path) ──────────────

const STAGE_CONFIDENCE: Record<GovernanceStage, number> = {
  monitoring: 0.1,
  discussion: 0.2,
  snapshot: 0.3,
  onchain_vote: 0.6,
  timelock: 0.85,
  executed: 1.0,
  canceled: 0.0,
}

const STAGE_MIN_CONFIDENCE: Record<GovernanceStage, number> = {
  monitoring: 0.60,
  discussion: 0.50,  // Forum posts: high bar for quality
  snapshot: 0.55,    // Snapshots: very high bar (often speculative)
  onchain_vote: 0.50,
  timelock: 0.40,
  executed: 0.30,
  canceled: 1.0, // canceled proposals should not generate new signals
}

// ─── Main Signal Generation ──────────────────────────────────────────

/**
 * Generate trade signals from a proposal analysis.
 * Routes to dynamic or legacy path based on analysis type.
 */
export function generateSignals(
  analysis: ProposalAnalysis,
  currentPositions: Position[],
): TradeSignal[] {
  if (isIntelligentAnalysis(analysis) && analysis.dynamicImpacts.length > 0) {
    return generateDynamicSignals(analysis, currentPositions)
  }
  return generateLegacySignals(analysis, currentPositions)
}

// ─── Contradictory Signal Resolution (shared) ──────────────────────

/**
 * If the same asset has both long AND short signals from the same proposal,
 * keep only the one with higher confidence. Conflicting directions cancel out
 * alpha and create unnecessary losses.
 *
 * This is a structural improvement, not overfitting:
 * - Contradictory signals indicate ambiguous analysis → bet on strongest signal only
 * - The losing leg typically wipes out the winning leg's PnL
 */
function resolveContradictorySignals(signals: TradeSignal[]): TradeSignal[] {
  const assetSignals = new Map<string, TradeSignal[]>()
  for (const sig of signals) {
    const key = sig.asset.toUpperCase()
    if (!assetSignals.has(key)) assetSignals.set(key, [])
    assetSignals.get(key)!.push(sig)
  }

  const resolved: TradeSignal[] = []
  for (const [asset, group] of assetSignals) {
    const hasLong = group.some(s => s.direction === 'long')
    const hasShort = group.some(s => s.direction === 'short')

    if (hasLong && hasShort) {
      group.sort((a, b) => b.confidence - a.confidence)
      const winner = group[0]
      log.info(
        { asset, kept: winner.direction, confidence: winner.confidence.toFixed(3), droppedCount: group.length - 1 },
        'Contradictory signals resolved: keeping highest confidence',
      )
      resolved.push(winner)
    } else {
      resolved.push(...group)
    }
  }

  return resolved
}

// ─── Dynamic Signal Generation ───────────────────────────────────────

function generateDynamicSignals(
  analysis: IntelligentAnalysis,
  currentPositions: Position[],
): TradeSignal[] {
  const signals: TradeSignal[] = []
  const minConfidence = getMinConfidence(analysis.stage)

  // DEDUP: Track which (asset, direction) combos we've already generated for THIS proposal
  // A single proposal should NOT generate multiple trades on the same asset
  const seenAssetDirection = new Set<string>()

  // Architecture insight: On-chain proposals are CONFIRMATION signals, not EARLY alpha.
  // By the time something reaches on-chain vote, the market has already priced it in.
  // Even on-chain SHORTS have mixed results — only the truly bearish events
  // (freeze, delisting) reliably produce price drops from on-chain.
  // For all other directional signals, FORUM POSTS are the alpha source (discussion phase).
  // Therefore: on-chain proposals → only shorts for freeze/delisting, otherwise skip.
  const isOnchain = analysis.stage === 'onchain_vote'
  const onchainLongsAllowed = !isOnchain

  for (const impact of analysis.dynamicImpacts) {
    // Skip non-tradeable impacts
    if (!impact.tradingOpportunity) continue

    // Find the matching strategy
    const strategy = STRATEGY_MATRIX.find((s) => s.proposalType === impact.type)
    if (!strategy) continue

    // Generate raw signal specs from the strategy
    const specs = strategy.generateSignals(impact, analysis)

    for (const spec of specs) {
      // Filter out stablecoins — they don't move enough to profit from directional trades
      if (STABLECOINS.has(spec.asset.toUpperCase())) {
        log.debug({ asset: spec.asset }, 'Skipping stablecoin — insufficient price volatility for directional trade')
        continue
      }

      // ─── TRADEABLE ASSET WHITELIST ──────────────────────────────────
      // Only trade assets from our curated protocol list.
      // NLP may extract tokens from proposal text that we don't monitor
      // (e.g. "1INCH" mentioned in a Compound proposal). Without this
      // filter, the bot trades unmonitored assets with no governance signal.
      if (!TRADEABLE_ASSETS.has(spec.asset.toUpperCase())) {
        log.debug(
          { asset: spec.asset },
          'Asset not in curated tradeable list — skipping',
        )
        continue
      }
      // ─── end tradeable asset whitelist ─────────────────────────────

      // ─── STALE PRICE GUARD ────────────────────────────────────────
      // Don't trade assets for which the price service has no recent data.
      // Stale or missing prices cause trades to sit with zero movement,
      // wasting capital and portfolio capacity.
      const priceSvc = getPriceService()
      if (priceSvc) {
        const now = getClock().now()
        const currentPrice = priceSvc.getPrice(spec.asset, now)
        const dayAgoPrice = priceSvc.getPrice(spec.asset, now - 24 * 3600_000)
        if (!currentPrice || !dayAgoPrice) {
          log.debug(
            { asset: spec.asset },
            'Stale price guard: no price data available — skipping trade',
          )
          continue
        }
      }
      // ─── end stale price guard ─────────────────────────────────────

      // DEDUP: One signal per asset per direction per proposal
      const dedupKey = `${spec.asset}:${spec.direction}`
      if (seenAssetDirection.has(dedupKey)) {
        log.debug({ asset: spec.asset, direction: spec.direction }, 'Dedup: skipping duplicate asset+direction for same proposal')
        continue
      }
      seenAssetDirection.add(dedupKey)

      // On-chain: allow longs ONLY for high-confidence risk_mitigation types
      // These represent structural changes (v2 → v3 migration, protocol upgrades) that
      // have alpha even after on-chain voting starts.
      if (!onchainLongsAllowed && spec.direction === 'long') {
        const ON_CHAIN_LONG_TYPES = new Set(['risk_mitigation', 'protocol_deployment'])
        if (!ON_CHAIN_LONG_TYPES.has(impact.type)) {
          log.debug({ asset: spec.asset, stage: analysis.stage, type: impact.type }, 'On-chain: skipping long (forum captures early alpha)')
          continue
        }
      }

      // SMART LONG FILTER: Allow longs ONLY from types with proven directional alpha.
      // Backtest evidence: 34 longs at 35% WR lost -$12,657. Being highly selective is critical.
      // Types with proven long alpha:
      //   - risk_mitigation: v2 deprecation → v3 growth narrative (structural change)
      //   - protocol_deployment: expansion to new chains = clear bullish catalyst
      //   - technical_parameter: supply cap increases, LTV changes = growing demand
      // Excluded types (noise, already priced in, or speculative):
      //   - governance_process: too noisy, decentralization proposals rarely move price
      //   - asset_onboarding: market prices this before on-chain execution
      //   - economic_policy: buyback effects take months, not actionable alpha
      if (spec.direction === 'long') {
        const LONG_ALPHA_TYPES = new Set<string>([
          'risk_mitigation',
          'protocol_deployment',
          'technical_parameter',
        ])
        if (!LONG_ALPHA_TYPES.has(impact.type)) {
          log.debug(
            { asset: spec.asset, type: impact.type, stage: analysis.stage },
            'Smart filter: skipping long from non-alpha type (routine governance, already priced in)',
          )
          continue
        }

        // ─── A3: MOMENTUM CONFIRMATION FILTER (Longs only) ──────────
        // Governance-bullish events produce slow, gradual price increases.
        // They CANNOT overcome strong negative momentum — entering longs
        // in ANY downtrend has terrible win rate (backtest: 35% WR for longs).
        // Tightened from -15% 14d to -8% 14d based on loss analysis.
        // Fail-open: if no price data available, allow the trade.
        const mom14d_a3 = getMomentum(spec.asset, getClock().now(), 14)
        if (mom14d_a3 !== null && mom14d_a3 < -0.08) {
          log.debug(
            { asset: spec.asset, mom14d: (mom14d_a3 * 100).toFixed(1) + '%' },
            'A3: Long blocked — asset in 14d downtrend (< -8%)',
          )
          continue
        }

        // Block if 7d momentum is negative (< -5%). Short-term downtrends
        // kill governance-long alpha even if 14d is flat.
        const mom7d_a3 = getMomentum(spec.asset, getClock().now(), 7)
        if (mom7d_a3 !== null && mom7d_a3 < -0.05) {
          log.debug(
            { asset: spec.asset, mom7d: (mom7d_a3 * 100).toFixed(1) + '%' },
            'A3: Long blocked — 7d momentum negative (< -5%)',
          )
          continue
        }

        // Block if 3d momentum is strongly negative (< -4%).
        const mom3d_a3 = getMomentum(spec.asset, getClock().now(), 3)
        if (mom3d_a3 !== null && mom3d_a3 < -0.04) {
          log.debug(
            { asset: spec.asset, mom3d: (mom3d_a3 * 100).toFixed(1) + '%' },
            'A3: Long blocked — 3d momentum negative (< -4%)',
          )
          continue
        }

        // ─── A3b: ETH MACRO CHECK (Longs only) ─────────────────────
        // Altcoins follow ETH. If ETH is in a significant 14d downtrend (< -8%),
        // governance-bullish signals on altcoins get crushed by macro.
        // Threshold at -8% (not -5%) to allow longs during normal corrections.
        const ethMom14d_a3 = getMomentum('WETH', getClock().now(), 14)
        if (ethMom14d_a3 !== null && ethMom14d_a3 < -0.08) {
          log.debug(
            { asset: spec.asset, ethMom14d: (ethMom14d_a3 * 100).toFixed(1) + '%' },
            'A3b: Long blocked — ETH in 14d downtrend (macro headwind)',
          )
          continue
        }
        // ─── end A3 ──────────────────────────────────────────────────
      }

      // ─── B2: V-REVERSAL SHORT PROTECTION ──────────────────────────
      // After a V-reversal (ETH crash >10% + recovery >8% in 14 days),
      // short-sellers are exhausted and buyers are stepping in.
      // Opening new shorts in this environment is dangerous.
      // Block shorts during V-reversals to avoid fighting the recovery.
      // Fail-open: if no price data, allow the trade.
      if (spec.direction === 'short' && hasEthVReversal(getClock().now())) {
        log.debug(
          { asset: spec.asset },
          'B2: Short blocked — ETH V-reversal detected (crash + fast recovery)',
        )
        continue
      }
      // ─── end B2 ───────────────────────────────────────────────────

      // On-chain shorts: only for clearly bearish technical events
      if (isOnchain && spec.direction === 'short') {
        const bearishTechnicals = new Set([
          'reserve_freeze', 'asset_delisting',
          'ltv_change', 'liquidation_threshold_change',
          'supply_cap_change', 'borrow_cap_change',   // Cap decreases indicate risk
          'interest_rate_change',                       // Rate decreases = revenue concern
        ])
        const isHighConvictionBearish = impact.type === 'risk_mitigation' ||
          (impact.type === 'technical_parameter' && bearishTechnicals.has(impact.technicalCategory ?? '')) ||
          impact.type === 'economic_policy' // Economic policy bearish = emission cuts
        if (!isHighConvictionBearish) {
          log.debug({ asset: spec.asset, type: impact.type }, 'On-chain: skipping non-bearish short')
          continue
        }
      }
      // Calculate ML-based confidence
      const confidence = calculateConfidence(analysis, impact, spec.direction, spec.asset)

      // ─── MARKET CONTEXT LOGGING ─────────────────────────────────
      // Log drawdown and momentum for analysis but don't filter based on them.
      // Evidence shows April 2025 losses were not predictable with historical filters:
      // the asset was still falling (-24.8% 7d) when we shorted, bounce came after.
      if (spec.direction === 'short') {
        const drawdown = getDrawdownFromHigh(spec.asset, getClock().now())
        const momentum = getShortTermMomentum(spec.asset, getClock().now())
        if (drawdown > 0 || momentum !== 0) {
          log.debug(
            { asset: spec.asset, drawdown: (drawdown * 100).toFixed(1) + '%', momentum: (momentum * 100).toFixed(1) + '%' },
            'Market context for short',
          )
        }
      }

      // Skip low-confidence signals.
      // Direction-asymmetric: longs need higher confidence (governance-bullish alpha is weaker).
      const directionMinConf = spec.direction === 'long'
        ? minConfidence + 0.10   // Longs: +0.10 (e.g. discussion 0.60, snapshot 0.65)
        : minConfidence          // Shorts: use stage-based threshold as-is
      if (confidence < directionMinConf) {
        log.debug(
          { confidence: confidence.toFixed(3), minConfidence: directionMinConf, asset: spec.asset, type: impact.type, direction: spec.direction },
          'Dynamic signal rejected: below minimum confidence',
        )
        continue
      }

      // ─── TIERED PROTOCOL CONFIDENCE ──────────────────────────────
      // New protocols have less governance data → require stronger signals.
      // This prevents noisy trades from new protocols triggering drawdown limits
      // that would block subsequent high-quality trades from established protocols.
      const protocolMinConf = getProtocolMinConfidence(impact.affectedProtocols)
      if (protocolMinConf > 0 && confidence < protocolMinConf) {
        log.debug(
          { confidence: confidence.toFixed(3), protocolMin: protocolMinConf, asset: spec.asset, protocols: impact.affectedProtocols },
          'Signal rejected: below new-protocol confidence threshold',
        )
        continue
      }
      // ─── end tiered confidence ───────────────────────────────────

      // ─── Kelly-based position sizing + leverage ──────────────
      let kelly = calculateKellyPosition(confidence, spec.urgency, spec.asset, 'binance', spec.direction)

      const riskProfile = selectRiskProfile(spec.urgency, confidence, kelly.leverage, spec.direction)

      // ─── PORTFOLIO CORRELATION + HEAT CHECK ───────────────────
      // 1. Don't open on same asset or correlated assets (ETH/WETH/WSTETH etc.)
      // 2. Limit total open positions to prevent overexposure
      const CORRELATION_GROUPS: Record<string, string> = {
        ETH: 'eth', WETH: 'eth', WSTETH: 'eth', STETH: 'eth',
        CBETH: 'eth', RETH: 'eth', WEETH: 'eth', PUFETH: 'eth',
        BTC: 'btc', WBTC: 'btc', CBBTC: 'btc',
      }
      const specGroup = CORRELATION_GROUPS[spec.asset.toUpperCase()]

      // ─── OPPOSING POSITION GUARD (dYdX v4: one position per market) ─
      // On dYdX v4 perpetuals, only ONE position per market is allowed.
      // If there's already an open position in the OPPOSITE direction on
      // the same asset (or correlated asset), skip this signal.
      // Without this guard, different proposals can open LONG + SHORT on
      // the same asset simultaneously, which is impossible on the exchange
      // and causes phantom P&L in backtests.
      const opposingPosition = currentPositions.find((p) => {
        const isOpposite =
          (spec.direction === 'long' && safeParseFloat(p.size) < 0) ||
          (spec.direction === 'short' && safeParseFloat(p.size) > 0)
        if (!isOpposite) return false

        if (p.asset === spec.asset && p.protocol === spec.protocol) return true
        if (specGroup) {
          const existingGroup = CORRELATION_GROUPS[p.asset.toUpperCase()]
          if (existingGroup === specGroup) return true
        }
        return false
      })

      if (opposingPosition) {
        const existingDir = safeParseFloat(opposingPosition.size) > 0 ? 'long' : 'short'
        log.debug(
          { asset: spec.asset, direction: spec.direction, existingAsset: opposingPosition.asset, existingDirection: existingDir },
          'Opposing position exists on same asset — skipping (dYdX: one position per market)',
        )
        continue
      }
      // ─── end opposing position guard ────────────────────────────────

      const existingPosition = currentPositions.find((p) => {
        const sameDirection =
          (spec.direction === 'long' && safeParseFloat(p.size) > 0) ||
          (spec.direction === 'short' && safeParseFloat(p.size) < 0)
        if (!sameDirection) return false

        // Same asset on same protocol
        if (p.asset === spec.asset && p.protocol === spec.protocol) return true

        // Correlated group check (only ETH/BTC derivatives)
        if (specGroup) {
          const existingGroup = CORRELATION_GROUPS[p.asset.toUpperCase()]
          if (existingGroup === specGroup) return true
        }
        return false
      })

      if (existingPosition) {
        log.debug(
          { asset: spec.asset, direction: spec.direction, existingAsset: existingPosition.asset },
          'Position or correlated position already exists — skipping',
        )
        continue
      }

      // Portfolio heat check: max 8 open positions
      if (currentPositions.length >= 8) {
        log.debug({ openPositions: currentPositions.length }, 'Portfolio full — skipping')
        continue
      }

      // All curated protocols use full Kelly sizing — the protocol list only includes
      // protocols with proven governance alpha and active dYdX markets.
      // Tier 2 protocols (non-core) get a 2x leverage cap for risk management,
      // but full Kelly SIZE — DYDX (71% WR) and ARB (67% WR) backtest proves this.
      const scaledSize = kelly.sizePct
      let scaledLeverage = kelly.leverage

      // ─── C1: PROTOCOL-TIERED LEVERAGE CAP ──────────────────────────
      // Established protocols with proven governance alpha: full leverage (up to C4 cap).
      // arbitrum added: 67% WR over 6 trades — proven alpha justifies removing 2x cap.
      // dydx added: 71% WR, but C4 already caps at 2x (low liquidity) — no behavior change.
      // lido added: 50% WR / 2 trades — sufficient track record.
      // Remaining Tier 2 (newer/unproven): max 2x leverage.
      const TIER1_PROTOCOLS = new Set(['aave', 'compound', 'uniswap', 'maker', 'arbitrum', 'dydx', 'lido'])
      const isTier1 = impact.affectedProtocols.some(p => TIER1_PROTOCOLS.has(p))

      if (!isTier1) {
        scaledLeverage = Math.min(scaledLeverage, 2)
      }
      // ─── end C1 ────────────────────────────────────────────────────

      // ─── C2: EXHAUSTED MOVE LEVERAGE CAP ────────────────────────
      // General trading principle: after large moves, mean-reversion risk
      // increases. Don't pile leverage on exhausted trends.
      //
      // "Exhausted move": asset already moved >15% in 7d in our trade
      // direction → the easy money is already made. Cap leverage to 1x.
      // This 15% threshold is ~2 standard deviations for DeFi assets
      // (typical daily vol 3-5%), a statistically significant move.
      //
      // Note: Counter-trend filter (asset moving against us) was REMOVED.
      // Data analysis showed it affected 6 winning trades and 0 losing trades —
      // governance alpha overpowers short-term counter-moves. The filter
      // only penalized winning signals without protecting against losses.
      {
        const mom7d = getMomentum(spec.asset, getClock().now(), 7)
        if (mom7d !== null) {
          const moveInTradeDir = spec.direction === 'short' ? -mom7d : mom7d

          if (moveInTradeDir > 0.15) {
            // Exhausted move: asset already moved 15%+ in our direction
            const prevLev = scaledLeverage
            scaledLeverage = Math.min(scaledLeverage, 1)
            if (prevLev > 1) {
              log.debug(
                { asset: spec.asset, direction: spec.direction, mom7d: (mom7d * 100).toFixed(1) + '%', levBefore: prevLev.toFixed(1), levAfter: scaledLeverage.toFixed(1) },
                'C2: Exhausted move — leverage capped to 1x',
              )
            }
          }
        }
      }
      // ─── end C2 ────────────────────────────────────────────────────

      // ─── C3: ETH REGIME LEVERAGE SCALING (Shorts only) ────────────
      // General principle: altcoins move with ETH. When ETH is in a
      // STRONG uptrend (>15% in 14d), shorting altcoins fights the macro tide.
      // Threshold raised from 5% to 15% based on data: at 5%, the filter
      // triggered on 9 winning trades vs 2 losing trades — too aggressive.
      // At 15%, only truly strong bull markets reduce short leverage.
      // Fail-open: no data → no adjustment.
      if (spec.direction === 'short') {
        const ethMom14d = getMomentum('WETH', getClock().now(), 14)
        if (ethMom14d !== null && ethMom14d > 0.15) {
          const prevLev = scaledLeverage
          scaledLeverage = Math.max(1, Math.round(scaledLeverage * 0.5 * 10) / 10)
          if (prevLev !== scaledLeverage) {
            log.debug(
              { asset: spec.asset, ethMom14d: (ethMom14d * 100).toFixed(1) + '%', levBefore: prevLev.toFixed(1), levAfter: scaledLeverage.toFixed(1) },
              'C3: ETH uptrend — short leverage halved',
            )
          }
        }
      }
      // ─── end C3 ────────────────────────────────────────────────────

      // ─── C4: LIQUIDITY-BASED LEVERAGE CAP ─────────────────────────
      // General principle: leverage should scale with market liquidity.
      // Illiquid assets (high slippage) have wider bid-ask spreads and
      // can gap through stop-losses. High leverage on low-liquidity
      // assets creates outsized losses.
      // Uses the same dYdX liquidity multiplier tiers from the executor:
      //   Tier 1 (1.0-1.5x slip): full leverage (ETH, AAVE, LINK, etc.)
      //   Tier 2 (2.0-2.5x slip): max 3x leverage (COMP, SNX, LDO)
      //   Tier 3 (3.0x+ slip): max 2x leverage (CRV, WSTETH, RETH)
      //   Tier 4 (5.0x+ slip): max 1x leverage (SKY)
      {
        const LIQUIDITY_LEV_CAP: Record<string, number> = {
          // Tier 1: Very liquid — no additional cap
          ETH: 7, WETH: 7, BTC: 7, WBTC: 7, CBBTC: 7,
          AAVE: 7, LINK: 7, UNI: 7, ARB: 7, OP: 7,
          COMP: 5, // COMP has decent dYdX liquidity — allow up to 5x
          // Tier 2: Medium liquidity — max 3x
          SNX: 3, LDO: 3,
          ENA: 3,   // $44k 24h volume — medium liquidity
          // Tier 3: Lower liquidity — max 2x
          CRV: 2, WSTETH: 2, RETH: 2, CBETH: 2,
          DYDX: 2,  // $235 24h volume — lower liquidity
          EIGEN: 2, // $819 24h volume — lower liquidity
          // Tier 4: Very low liquidity — no leverage
          SKY: 1,
        }
        const liqCap = LIQUIDITY_LEV_CAP[spec.asset.toUpperCase()] ?? 2
        if (scaledLeverage > liqCap) {
          log.debug(
            { asset: spec.asset, levBefore: scaledLeverage.toFixed(1), levAfter: liqCap.toFixed(1) },
            'C4: Liquidity cap — leverage reduced for low-liquidity asset',
          )
          scaledLeverage = liqCap
        }
      }
      // ─── end C4 ────────────────────────────────────────────────────

      const signal: TradeSignal = {
        id: randomUUID(),
        asset: spec.asset,
        direction: spec.direction,
        sizePct: scaledSize,
        protocol: spec.protocol,
        confidence,
        rationale: spec.rationale,
        proposalId: analysis.proposalId,
        governanceStage: analysis.stage,
        timestamp: getClock().now(),
        urgency: spec.urgency,
        leverage: scaledLeverage,
        stopLossPct: riskProfile.stopLossPct,
        takeProfitPct: riskProfile.takeProfitPct,
        trailingStopActivation: riskProfile.trailingStopActivation,
        trailingStopDistance: riskProfile.trailingStopDistance,
        maxHoldingHours: riskProfile.maxHoldingHours,
      }

      signals.push(signal)
      log.info(
        {
          asset: signal.asset,
          direction: signal.direction,
          protocol: signal.protocol,
          confidence: confidence.toFixed(3),
          sizePct: kelly.sizePct.toFixed(2),
          leverage: kelly.leverage.toFixed(1) + 'x',
          type: impact.type,
          stage: analysis.stage,
        },
        'Generated dynamic trade signal',
      )
    }
  }

  return resolveContradictorySignals(signals)
}

// ─── Legacy Signal Generation (backward compatibility) ───────────────

/**
 * Legacy rules for generating trade signals from ProposalImpact[].
 * Used when the analysis doesn't have dynamicImpacts.
 */
function generateLegacySignals(
  analysis: ProposalAnalysis,
  currentPositions: Position[],
): TradeSignal[] {
  const signals: TradeSignal[] = []
  const stageConfidence = STAGE_CONFIDENCE[analysis.stage] ?? 0.1
  const minConfidence = STAGE_MIN_CONFIDENCE[analysis.stage] ?? 0.15

  // DEDUP: Track which (asset, direction) combos we've already generated
  const seenAssetDirection = new Set<string>()

  // On-chain proposals: only allow shorts (see rationale in generateDynamicSignals)
  const legacyOnchainLongsAllowed = analysis.stage !== 'onchain_vote'

  for (let impact of analysis.impacts) {
    // Categories with inherent direction don't need detectDecrease
    const FIXED_DIRECTION_CATEGORIES = new Set([
      'reserve_freeze',     // Always bearish (short)
      'asset_listing',      // Always bullish (long)
    ])

    let isDecrease: boolean
    if (FIXED_DIRECTION_CATEGORIES.has(impact.category)) {
      // reserve_freeze is inherently bearish, asset_listing is inherently bullish
      isDecrease = impact.category === 'reserve_freeze'
    } else {
      const isDecreaseOrNull = detectDecrease(impact, analysis.description || analysis.title)

      // If direction is truly unknown, skip this impact — don't guess
      if (isDecreaseOrNull === null) {
        log.debug(
          { category: impact.category, asset: impact.asset },
          'Legacy signal skipped: direction unknown (no delta, no NLP match)',
        )
        continue
      }
      isDecrease = isDecreaseOrNull
    }

    const rules = getLegacyTradeRules(impact, isDecrease)

    for (let rule of rules) {
      const confidence = Math.min(
        rule.baseConfidence * stageConfidence * (0.5 + analysis.confidenceScore * 0.5),
        1,
      )

      if (confidence < minConfidence) {
        log.debug(
          { confidence: confidence.toFixed(3), minConfidence, stage: analysis.stage },
          'Legacy signal rejected: below minimum confidence',
        )
        continue
      }

      // Stablecoins: don't trade the stablecoin itself, but if it's a SHORT signal,
      // redirect to shorting the governance token (protocol risk signal)
      if (STABLECOINS.has(impact.asset.toUpperCase())) {
        if (rule.direction === 'short') {
          // Redirect: short the governance token instead of the stablecoin
          const govToken = getGovTokenForAsset(impact.asset, [analysis.protocol])
          if (govToken) {
            impact = { ...impact, asset: govToken }
            rule = { ...rule, rationale: `${rule.rationale} (redirected from stablecoin ${impact.asset} to ${govToken})` }
          } else {
            log.debug({ asset: impact.asset }, 'Legacy: skipping stablecoin short — no gov token')
            continue
          }
        } else {
          log.debug({ asset: impact.asset }, 'Legacy: skipping stablecoin long — insufficient volatility')
          continue
        }
      }

      // ─── TRADEABLE ASSET WHITELIST (Legacy) ─────────────────────
      if (!TRADEABLE_ASSETS.has(impact.asset.toUpperCase())) {
        log.debug({ asset: impact.asset }, 'Legacy: asset not in curated tradeable list — skipping')
        continue
      }
      // ─── end tradeable asset whitelist ─────────────────────────

      // ─── STALE PRICE GUARD (Legacy) ────────────────────────────
      const priceSvcLegacy = getPriceService()
      if (priceSvcLegacy) {
        const nowLeg = getClock().now()
        const currentPriceLeg = priceSvcLegacy.getPrice(impact.asset, nowLeg)
        const dayAgoPriceLeg = priceSvcLegacy.getPrice(impact.asset, nowLeg - 24 * 3600_000)
        if (!currentPriceLeg || !dayAgoPriceLeg) {
          log.debug({ asset: impact.asset }, 'Legacy: stale price guard — no price data, skipping')
          continue
        }
      }
      // ─── end stale price guard ─────────────────────────────────

      // DEDUP: One signal per asset per direction per proposal
      const dedupKey = `${impact.asset}:${rule.direction}`
      if (seenAssetDirection.has(dedupKey)) {
        log.debug({ asset: impact.asset, direction: rule.direction }, 'Legacy dedup: skipping duplicate')
        continue
      }
      seenAssetDirection.add(dedupKey)

      // On-chain: skip longs entirely
      if (!legacyOnchainLongsAllowed && rule.direction === 'long') {
        log.debug({ asset: impact.asset, stage: analysis.stage }, 'Legacy: skipping on-chain long')
        continue
      }

      // SMART LONG FILTER: Only categories with proven long alpha pass through.
      // dsr_change longs (rate increase → MKR bullish) and interest_rate_change longs
      // have genuine alpha. asset_listing/supply_cap longs are routine and already priced in.
      // NOTE: reserve_freeze/asset_delisting are BEARISH (shorts), not long-alpha!
      if (rule.direction === 'long') {
        const LONG_ALPHA_CATEGORIES = new Set(['dsr_change', 'interest_rate_change'])
        if (!LONG_ALPHA_CATEGORIES.has(impact.category)) {
          log.debug({ asset: impact.asset, category: impact.category }, 'Legacy: skipping long from non-alpha category')
          continue
        }

        // ─── A3: MOMENTUM CONFIRMATION FILTER (Longs only) ──────────
        // A3b: Block longs in strong 14d downtrend
        const mom14dLeg = getMomentum(impact.asset, getClock().now(), 14)
        if (mom14dLeg !== null && mom14dLeg < -0.10) {
          log.debug(
            { asset: impact.asset, mom14d: (mom14dLeg * 100).toFixed(1) + '%' },
            'A3b: Legacy long blocked — asset in strong 14d downtrend',
          )
          continue
        }

        const mom1d = getMomentum(impact.asset, getClock().now(), 1)
        const mom3d = getMomentum(impact.asset, getClock().now(), 3)

        if (mom1d !== null && mom3d !== null) {
          if (mom1d <= 0 || mom3d <= 0) {
            log.debug(
              {
                asset: impact.asset,
                mom1d: (mom1d * 100).toFixed(1) + '%',
                mom3d: (mom3d * 100).toFixed(1) + '%',
              },
              'A3: Legacy long blocked — momentum not confirmed',
            )
            continue
          }
        }
        // ─── end A3 ──────────────────────────────────────────────────
      }

      // ─── B2: V-REVERSAL SHORT PROTECTION ──────────────────────────
      if (rule.direction === 'short' && hasEthVReversal(getClock().now())) {
        log.debug(
          { asset: impact.asset },
          'B2: Legacy short blocked — ETH V-reversal detected',
        )
        continue
      }
      // ─── end B2 ───────────────────────────────────────────────────

      // On-chain shorts: only for truly bearish events
      if (analysis.stage === 'onchain_vote' && rule.direction === 'short') {
        const bearishCategories = new Set(['reserve_freeze', 'asset_delisting', 'ltv_change', 'liquidation_threshold_change'])
        if (!bearishCategories.has(impact.category)) {
          log.debug({ asset: impact.asset, category: impact.category }, 'Legacy: skipping non-bearish on-chain short')
          continue
        }
      }

      // ─── TIERED PROTOCOL CONFIDENCE (Legacy) ─────────────────
      const protocolMinConf = getProtocolMinConfidence([analysis.protocol])
      if (protocolMinConf > 0 && confidence < protocolMinConf) {
        log.debug(
          { confidence: confidence.toFixed(3), protocolMin: protocolMinConf, asset: impact.asset, protocol: analysis.protocol },
          'Legacy signal rejected: below new-protocol confidence threshold',
        )
        continue
      }
      // ─── end tiered confidence ───────────────────────────────────

      // ─── Kelly-based position sizing + leverage ──────────────
      const kellyLeg = calculateKellyPosition(confidence, rule.urgency, impact.asset, 'binance', rule.direction)
      let legacyLeverage = kellyLeg.leverage

      // ─── C1/C2/C3/C4 Leverage scaling (Legacy) ────────────────
      // Same rules as dynamic path — general trading principles.
      // C1: Discussion stage cap — see dynamic path for rationale (not applied for Tier 1).
      // Protocol tier for legacy path
      const TIER1_LEG = new Set(['aave', 'compound', 'uniswap', 'maker'])
      const isTier1Leg = TIER1_LEG.has(analysis.protocol)
      if (!isTier1Leg) {
        legacyLeverage = Math.min(legacyLeverage, 2)
        // Also halve position sizing for non-tier1
        // (applied via kellyLeg.sizePct below)
      }
      {
        const mom7dLeg = getMomentum(impact.asset, getClock().now(), 7)
        if (mom7dLeg !== null) {
          const moveInDir = rule.direction === 'short' ? -mom7dLeg : mom7dLeg
          if (moveInDir > 0.15) legacyLeverage = Math.min(legacyLeverage, 1)  // C2: Exhausted move
        }
      }
      if (rule.direction === 'short') {
        const ethMom14dLeg = getMomentum('WETH', getClock().now(), 14)
        if (ethMom14dLeg !== null && ethMom14dLeg > 0.15) {
          legacyLeverage = Math.max(1, Math.round(legacyLeverage * 0.5 * 10) / 10)
        }
      }
      // ─── end C1/C2/C3/C4 ──────────────────────────────────────

      const riskProfile = selectRiskProfile(rule.urgency, confidence, legacyLeverage, rule.direction)

      // Opposing position guard (dYdX v4: one position per market)
      const opposingPosLeg = currentPositions.find(
        (p) =>
          p.asset === impact.asset &&
          p.protocol === rule.protocol &&
          ((rule.direction === 'long' && safeParseFloat(p.size) < 0) ||
           (rule.direction === 'short' && safeParseFloat(p.size) > 0)),
      )

      if (opposingPosLeg) {
        log.debug(
          { asset: impact.asset, direction: rule.direction },
          'Opposing position exists — skipping (one position per market)',
        )
        continue
      }

      const existingPosition = currentPositions.find(
        (p) =>
          p.asset === impact.asset &&
          p.protocol === rule.protocol &&
          ((rule.direction === 'long' && safeParseFloat(p.size) > 0) ||
           (rule.direction === 'short' && safeParseFloat(p.size) < 0)),
      )

      if (existingPosition) continue

      signals.push({
        id: randomUUID(),
        asset: impact.asset,
        direction: rule.direction,
        sizePct: kellyLeg.sizePct,
        protocol: rule.protocol,
        confidence,
        rationale: rule.rationale,
        proposalId: analysis.proposalId,
        governanceStage: analysis.stage,
        timestamp: getClock().now(),
        urgency: rule.urgency,
        leverage: legacyLeverage,
        stopLossPct: riskProfile.stopLossPct,
        takeProfitPct: riskProfile.takeProfitPct,
        trailingStopActivation: riskProfile.trailingStopActivation,
        trailingStopDistance: riskProfile.trailingStopDistance,
        maxHoldingHours: riskProfile.maxHoldingHours,
      })
    }
  }

  // ─── CONTRADICTORY SIGNAL RESOLUTION (Legacy) ─────────────────
  // Same logic as dynamic path: if same asset has long+short, keep higher confidence.
  return resolveContradictorySignals(signals)
}

// ─── Legacy Trade Rules ──────────────────────────────────────────────

interface LegacyTradeRule {
  direction: OrderSide
  protocol: ExecutionProtocol
  baseSizePct: number
  baseConfidence: number
  urgency: 'low' | 'medium' | 'high'
  rationale: string
}

function getLegacyTradeRules(impact: ProposalImpact, isDecrease: boolean): LegacyTradeRule[] {
  const rules: LegacyTradeRule[] = []

  switch (impact.category) {
    case 'ltv_change':
    case 'liquidation_threshold_change':
      rules.push({
        direction: isDecrease ? 'short' : 'long',
        protocol: 'binance',
        baseSizePct: isDecrease ? 5 : 3,
        baseConfidence: isDecrease ? 0.7 : 0.5,
        urgency: 'high',
        rationale: isDecrease
          ? `LT decrease on ${impact.asset} may trigger liquidation cascade`
          : `LT increase on ${impact.asset} unlocks borrowing capacity`,
      })
      break

    case 'supply_cap_change':
      // Cap changes: trade directionally via dYdX
      rules.push({
        direction: isDecrease ? 'short' : 'long', protocol: 'binance', baseSizePct: 2, baseConfidence: 0.4,
        urgency: 'medium',
        rationale: isDecrease
          ? `Supply cap decrease on ${impact.asset} may signal risk concerns`
          : `Supply cap increase on ${impact.asset} signals growth`,
      })
      break

    case 'reserve_freeze':
      rules.push({
        direction: 'short', protocol: 'binance', baseSizePct: 5, baseConfidence: 0.8,
        urgency: 'high', rationale: `Reserve freeze on ${impact.asset} — flight to safety`,
      })
      break

    case 'interest_rate_change':
      // Trade via dYdX perpetual futures
      rules.push({
        direction: isDecrease ? 'short' : 'long', protocol: 'binance', baseSizePct: 2, baseConfidence: 0.4,
        urgency: 'medium',
        rationale: isDecrease
          ? `Rate decrease on ${impact.asset} — reduced protocol revenue`
          : `Rate increase on ${impact.asset} — increased protocol revenue`,
      })
      break

    case 'asset_listing':
      rules.push({
        direction: 'long', protocol: 'binance', baseSizePct: 4, baseConfidence: 0.6,
        urgency: 'medium', rationale: `New asset listing for ${impact.asset} — demand increase`,
      })
      break

    case 'asset_delisting':
      rules.push({
        direction: 'short', protocol: 'binance', baseSizePct: 5, baseConfidence: 0.8,
        urgency: 'high', rationale: `Asset delisting for ${impact.asset} — sell pressure`,
      })
      break

    case 'dsr_change':
      // Trade MKR instead of DAI — DAI is pegged, MKR reflects protocol health
      rules.push({
        direction: isDecrease ? 'short' : 'long', protocol: 'binance', baseSizePct: 3,
        baseConfidence: 0.6, urgency: 'high',
        rationale: isDecrease ? `DSR decrease — bearish for MKR` : `DSR increase — bullish for MKR`,
      })
      break
  }

  return rules
}

/**
 * Detect whether an impact represents a decrease.
 * Uses multiple signals: numeric values, delta, and NLP text patterns from the proposal description.
 * Returns: true = decrease, false = increase, null = truly unknown (skip signal)
 */
function detectDecrease(impact: ProposalImpact, proposalDescription?: string): boolean | null {
  // 1. Strongest signal: compare current vs proposed numeric values
  if (impact.currentValue && impact.proposedValue) {
    return parseFloat(impact.proposedValue) < parseFloat(impact.currentValue)
  }

  // 2. Explicit delta from decoder/NLP
  if (impact.delta) return parseFloat(impact.delta) < 0

  // 3. NLP-based: check proposal description text for decrease/increase keywords
  const desc = (proposalDescription ?? '').toLowerCase()
  if (desc.length > 0) {
    const DECREASE_WORDS = ['reduce', 'decrease', 'lower', 'cut', 'drop', 'remove', 'freeze', 'pause', 'deprecate', 'delist', 'shrink', 'wind down', 'offboard']
    const INCREASE_WORDS = ['increase', 'raise', 'expand', 'add', 'onboard', 'grow', 'boost', 'enable', 'activate', 'unfreeze', 'list']

    const hasDecrease = DECREASE_WORDS.some(w => desc.includes(w))
    const hasIncrease = INCREASE_WORDS.some(w => desc.includes(w))

    if (hasDecrease && !hasIncrease) return true
    if (hasIncrease && !hasDecrease) return false
  }

  // 4. Truly ambiguous — return null to indicate "don't generate signal"
  return null
}

// ─── Event Bus Integration ──────────────────────────────────────────

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
