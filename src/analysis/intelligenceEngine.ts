/**
 * Intelligence Engine — unified proposal analysis.
 *
 * Central orchestrator that replaces the rigid pattern-matching pipeline
 * with a flexible NLP-powered analysis system. Handles ALL proposal types:
 *   - On-chain GovernorBravo proposals (Compound, Uniswap)
 *   - Aave PayloadController proposals (IPFS-based)
 *   - Snapshot proposals (text-based classification)
 *   - Forum posts (sentiment signal)
 *
 * Produces IntelligentAnalysis which is backward-compatible with ProposalAnalysis
 * but adds: proposalType, dynamicImpacts, nlpConfidence, sentiment, extractedAssets.
 */
import { createLogger } from '../lib/logger.js'
import { analyzeText, type NLPResult } from './nlpEngine.js'
import { decodeGovernorBravoActions } from './proposalDecoder.js'
import { classifyProposal } from './proposalClassifier.js'
import { resolveAssetSymbol } from '../backtest/assetResolver.js'
import { getClock } from '../backtest/clock.js'
import type {
  ProposalCreatedEvent,
  SnapshotProposalEvent,
  ForumPostEvent,
  GovernanceProtocol,
  ProposalImpact,
  ImpactCategory,
  IntelligentAnalysis,
  DynamicImpact,
  ProposalType,
  PriceImpactExpectation,
  DecodedAction,
} from '../types/governance.js'

const log = createLogger('intelligence')

// ─── Protocol → Governance Token ─────────────────────────────────────

const PROTOCOL_GOV_TOKENS: Record<string, string> = {
  aave: 'AAVE',
  compound: 'COMP',
  uniswap: 'UNI',
  maker: 'SKY',         // MKR migrated to SKY
  lido: 'LDO',
  arbitrum: 'ARB',
  curve: 'CRV',
  synthetix: 'SNX',
  dydx: 'DYDX',
  eigenlayer: 'EIGEN',
  morpho: 'MORPHO',
  yearn: 'YFI',
  gmx: 'GMX',
  // ─── Removed (0 trades, no risk-parameter alpha) ─────────────────────────
  // optimism, ethena, ens, cosmos, injective, convex: no alpha
  // jupiter, celestia, avalanche, polygon, starknet, sui, sei, near, zksync: L1/L2 operational
  // drift, 1inch, jito, pyth, pendle, thegraph, euler, stacks, etherfi, wormhole: 0 trades
}

// ─── ImpactCategory ↔ ProposalType Bridge ────────────────────────────

const IMPACT_TO_PROPOSAL_TYPE: Partial<Record<ImpactCategory, ProposalType>> = {
  ltv_change: 'technical_parameter',
  liquidation_threshold_change: 'technical_parameter',
  supply_cap_change: 'technical_parameter',
  borrow_cap_change: 'technical_parameter',
  interest_rate_change: 'technical_parameter',
  debt_ceiling_change: 'technical_parameter',
  reserve_factor_change: 'technical_parameter',
  emode_change: 'technical_parameter',
  stability_fee_change: 'technical_parameter',
  dsr_change: 'technical_parameter',
  asset_listing: 'asset_onboarding',
  asset_delisting: 'risk_mitigation',
  oracle_change: 'infrastructure',
  reserve_freeze: 'risk_mitigation',
}

const PROPOSAL_TYPE_TO_IMPACT: Partial<Record<ProposalType, ImpactCategory>> = {
  technical_parameter: 'other',
  asset_onboarding: 'asset_listing',
  risk_mitigation: 'reserve_freeze',
  infrastructure: 'oracle_change',
  protocol_deployment: 'asset_listing',
  economic_policy: 'other',
  treasury_funding: 'other',
  governance_process: 'other',
}

// ─── Severity Mapping ────────────────────────────────────────────────

function assessDynamicSeverity(type: ProposalType, priceImpact: PriceImpactExpectation): 'low' | 'medium' | 'high' | 'critical' {
  if (priceImpact === 'strong_negative') return 'critical'
  if (priceImpact === 'strong_positive') return 'high'

  switch (type) {
    case 'risk_mitigation': return 'critical'
    case 'asset_onboarding': return 'high'
    case 'protocol_deployment': return 'high'
    case 'technical_parameter': return 'high'
    case 'economic_policy': return 'medium'
    case 'infrastructure': return 'medium'
    case 'treasury_funding': return 'low'
    case 'governance_process': return 'low'
    default: return 'medium'
  }
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Analyze an on-chain GovernorBravo proposal.
 * Combines calldata decoding (old system) with NLP analysis (new system).
 */
export function analyzeOnchainProposal(
  proposal: ProposalCreatedEvent,
  spellActions?: DecodedAction[],
): IntelligentAnalysis {
  // 1. Decode actions using the old system (still useful for Compound/Uniswap)
  let actions = decodeGovernorBravoActions(proposal)

  // Override with spell actions if provided (Maker)
  if (spellActions && spellActions.length > 0) {
    actions = spellActions
  }

  // 2. Classify using old system (produces ProposalImpact[])
  const legacyImpacts = classifyProposal(actions)

  // 3. NLP analysis on the description
  const nlp = analyzeText(proposal.description, undefined, proposal.protocol)

  // 4. Build dynamic impacts
  const dynamicImpacts = buildDynamicImpacts(
    nlp,
    legacyImpacts,
    proposal.protocol,
  )

  // 5. Resolve assets: combine NLP-extracted + legacy-classified
  const allAssets = mergeAssets(nlp.extractedAssets, legacyImpacts, proposal.protocol)

  // 6. Determine proposal type: prefer legacy if it found technical impacts, else NLP
  const proposalType = legacyImpacts.length > 0
    ? (IMPACT_TO_PROPOSAL_TYPE[legacyImpacts[0].category] ?? nlp.proposalType)
    : nlp.proposalType

  const analysis: IntelligentAnalysis = {
    proposalId: `${proposal.protocol}:${proposal.proposalId.toString()}`,
    protocol: proposal.protocol,
    stage: 'onchain_vote',
    title: proposal.description.slice(0, 200),
    description: proposal.description,
    actions,
    impacts: legacyImpacts.length > 0
      ? legacyImpacts
      : synthesizeLegacyImpacts(nlp, allAssets),
    cascadeImpacts: [],
    confidenceScore: Math.max(nlp.typeConfidence, legacyImpacts.length > 0 ? 0.6 : 0.3),
    timestamp: getClock().now(),
    // New fields
    proposalType,
    dynamicImpacts,
    nlpConfidence: nlp.typeConfidence,
    sentiment: nlp.sentiment,
    extractedAssets: allAssets,
  }

  log.info(
    {
      proposalId: proposal.proposalId.toString(),
      protocol: proposal.protocol,
      proposalType,
      legacyImpacts: legacyImpacts.length,
      dynamicImpacts: dynamicImpacts.length,
      assets: allAssets.join(', '),
      nlpConfidence: nlp.typeConfidence.toFixed(2),
    },
    'On-chain proposal analyzed',
  )

  return analysis
}

/**
 * Analyze a Snapshot proposal using NLP.
 * This is the main improvement: handles ALL Snapshot types, not just technical ones.
 */
export function analyzeSnapshotProposal(
  snap: SnapshotProposalEvent,
): IntelligentAnalysis | null {
  // 1. NLP analysis on title + body
  const nlp = analyzeText(snap.title, snap.body, snap.protocol)

  // 2. Extract and resolve assets
  let assets = nlp.extractedAssets.map((a) => resolveAssetSymbol(a))
  // Deduplicate
  assets = [...new Set(assets)]

  // 3. If no assets found and proposal is actionable, use governance token
  if (assets.length === 0 && nlp.isActionable) {
    const govToken = PROTOCOL_GOV_TOKENS[snap.protocol]
    if (govToken) assets = [govToken]
  }

  // 4. If no assets found at all, use governance token as ultimate fallback
  // Snapshot proposals are significant governance events — always try to generate a signal
  if (assets.length === 0) {
    const govToken = PROTOCOL_GOV_TOKENS[snap.protocol]
    if (govToken) {
      assets = [govToken]
    } else {
      log.debug({ title: snap.title.slice(0, 80), type: nlp.proposalType }, 'Snapshot not actionable (no assets, no gov token)')
      return null
    }
  }

  // 5. Build dynamic impacts
  const dynamicImpacts = buildDynamicImpactsFromNLP(nlp, assets, snap.protocol)

  // 6. Synthesize legacy impacts for backward compatibility
  const legacyImpacts = synthesizeLegacyImpacts(nlp, assets)

  const analysis: IntelligentAnalysis = {
    proposalId: `snapshot:${snap.protocol}:${snap.snapshotId ?? 'unknown'}`,
    protocol: snap.protocol,
    stage: 'snapshot',
    title: snap.title,
    description: snap.body ?? '',
    actions: [],
    impacts: legacyImpacts,
    cascadeImpacts: [],
    confidenceScore: nlp.typeConfidence * 0.8, // Snapshot titles are less reliable
    timestamp: getClock().now(),
    // New fields
    proposalType: nlp.proposalType,
    dynamicImpacts,
    nlpConfidence: nlp.typeConfidence,
    sentiment: nlp.sentiment,
    extractedAssets: assets,
  }

  log.info(
    {
      title: snap.title.slice(0, 80),
      protocol: snap.protocol,
      type: nlp.proposalType,
      assets: assets.join(', '),
      dynamicImpacts: dynamicImpacts.length,
      sentiment: nlp.sentiment,
      confidence: nlp.typeConfidence.toFixed(2),
    },
    'Snapshot proposal analyzed',
  )

  return analysis
}

/**
 * Analyze a forum post for sentiment signal.
 * Returns null for non-actionable posts (most of them).
 * Forum posts alone rarely generate trade signals but contribute to confidence.
 */
export function analyzeForumPost(
  post: ForumPostEvent,
): IntelligentAnalysis | null {
  const nlp = analyzeText(post.title, undefined, post.protocol)

  // Forum posts: let ALL types through to the signal generator.
  // The signal generator already has proper filters:
  //   - governance_process only trades if sentiment != neutral
  //   - confidence thresholds, dedup, position limits, momentum checks
  // Previously, 1,119 forum posts were killed here as "governance_process"
  // even though many were misclassified (e.g. "Add gauge for X" = economic_policy).
  // The NLP default fallback assigns governance_process to ANY proposal that
  // doesn't strongly match known keyword patterns, which is overly aggressive.

  if (!nlp.isActionable) return null

  let assets = nlp.extractedAssets.map((a) => resolveAssetSymbol(a))

  // Governance token fallback (same as Snapshot path):
  // If no specific assets found, use the protocol's governance token.
  // Forum posts about protocol-level changes (treasury, process, deployment)
  // still affect the governance token's price.
  if (assets.length === 0) {
    const govToken = PROTOCOL_GOV_TOKENS[post.protocol]
    if (govToken) {
      assets = [govToken]
    } else {
      return null
    }
  }

  const dynamicImpacts = buildDynamicImpactsFromNLP(nlp, assets, post.protocol)
  const legacyImpacts = synthesizeLegacyImpacts(nlp, assets)

  return {
    proposalId: `forum-${post.protocol}-${post.topicId}`,
    protocol: post.protocol,
    stage: 'discussion',
    title: post.title,
    description: '',
    actions: [],
    impacts: legacyImpacts,
    cascadeImpacts: [],
    confidenceScore: nlp.typeConfidence * 0.7, // Forum posts have moderate confidence (they're early alpha)
    timestamp: getClock().now(),
    proposalType: nlp.proposalType,
    dynamicImpacts,
    nlpConfidence: nlp.typeConfidence,
    sentiment: nlp.sentiment,
    extractedAssets: assets,
  }
}

// ─── Internal: Build Dynamic Impacts ─────────────────────────────────

/**
 * Build dynamic impacts by combining NLP results with legacy calldata analysis.
 */
function buildDynamicImpacts(
  nlp: NLPResult,
  legacyImpacts: ProposalImpact[],
  protocol: GovernanceProtocol,
): DynamicImpact[] {
  const dynamicImpacts: DynamicImpact[] = []

  // If legacy classifier found impacts, create dynamic impacts from them
  if (legacyImpacts.length > 0) {
    for (const legacy of legacyImpacts) {
      const resolvedAsset = resolveAssetSymbol(legacy.asset)
      const proposalType = IMPACT_TO_PROPOSAL_TYPE[legacy.category] ?? nlp.proposalType

      dynamicImpacts.push({
        type: proposalType,
        affectedAssets: [resolvedAsset],
        affectedProtocols: [protocol],
        technicalCategory: legacy.category,
        expectedPriceImpact: nlp.expectedPriceImpact,
        tradingOpportunity: true,
        confidence: 0.7, // High confidence for calldata-decoded impacts
        severity: legacy.severity,
        rationale: `${legacy.category} on ${resolvedAsset} (calldata-decoded)`,
      })
    }
  }

  // Also add NLP-derived impact if it found ADDITIONAL assets not covered by legacy.
  // Previously this only fired when dynamicImpacts was empty, ignoring NLP insights
  // when legacy found at least one impact. Now we always check for new assets.
  if (nlp.isActionable) {
    const nlpAssets = nlp.extractedAssets.map((a) => resolveAssetSymbol(a))
    if (nlpAssets.length === 0) {
      const govToken = PROTOCOL_GOV_TOKENS[protocol]
      if (govToken) nlpAssets.push(govToken)
    }

    // Find assets not already covered by legacy-derived impacts
    const coveredAssets = new Set(dynamicImpacts.flatMap(d => d.affectedAssets.map(a => a.toUpperCase())))
    const newAssets = nlpAssets.filter(a => !coveredAssets.has(a.toUpperCase()))

    if (newAssets.length > 0) {
      dynamicImpacts.push({
        type: nlp.proposalType,
        affectedAssets: newAssets,
        affectedProtocols: [protocol],
        expectedPriceImpact: nlp.expectedPriceImpact,
        tradingOpportunity: nlp.proposalType !== 'governance_process',
        confidence: nlp.typeConfidence,
        severity: assessDynamicSeverity(nlp.proposalType, nlp.expectedPriceImpact),
        rationale: `${nlp.proposalType}: ${nlp.keywords.join(', ')} (NLP-classified, additional assets)`,
      })
    }
  }

  return dynamicImpacts
}

/**
 * Build dynamic impacts purely from NLP (for Snapshot/Forum where there's no calldata).
 */
function buildDynamicImpactsFromNLP(
  nlp: NLPResult,
  assets: string[],
  protocol: GovernanceProtocol,
): DynamicImpact[] {
  if (assets.length === 0) return []

  const severity = assessDynamicSeverity(nlp.proposalType, nlp.expectedPriceImpact)

  // Determine if this is a trading opportunity
  // All types except pure governance_process can generate signals
  const tradeable = nlp.proposalType !== 'governance_process'

  return [{
    type: nlp.proposalType,
    affectedAssets: assets,
    affectedProtocols: [protocol],
    technicalCategory: PROPOSAL_TYPE_TO_IMPACT[nlp.proposalType],
    expectedPriceImpact: nlp.expectedPriceImpact,
    tradingOpportunity: tradeable,
    confidence: nlp.typeConfidence,
    severity,
    rationale: `${nlp.proposalType}: ${nlp.keywords.slice(0, 3).join(', ')} (NLP)`,
  }]
}

// ─── Internal: Asset Merging ─────────────────────────────────────────

function mergeAssets(
  nlpAssets: string[],
  legacyImpacts: ProposalImpact[],
  protocol: GovernanceProtocol,
): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  // Add NLP-extracted assets (resolved)
  for (const asset of nlpAssets) {
    const resolved = resolveAssetSymbol(asset)
    if (!seen.has(resolved)) {
      seen.add(resolved)
      result.push(resolved)
    }
  }

  // Add legacy-classified assets (resolved)
  for (const impact of legacyImpacts) {
    const resolved = resolveAssetSymbol(impact.asset)
    if (!seen.has(resolved)) {
      seen.add(resolved)
      result.push(resolved)
    }
  }

  // Fallback: governance token
  if (result.length === 0) {
    const govToken = PROTOCOL_GOV_TOKENS[protocol]
    if (govToken) result.push(govToken)
  }

  return result
}

// ─── Internal: Synthesize Legacy Impacts ─────────────────────────────

/**
 * Create ProposalImpact[] from NLP results for backward compatibility.
 * This allows the old signal generator to still work if needed.
 */
function synthesizeLegacyImpacts(
  nlp: NLPResult,
  assets: string[],
): ProposalImpact[] {
  if (assets.length === 0) return []

  const category: ImpactCategory = PROPOSAL_TYPE_TO_IMPACT[nlp.proposalType] ?? 'other'

  const severity = assessDynamicSeverity(nlp.proposalType, nlp.expectedPriceImpact)

  const impacts: ProposalImpact[] = []

  for (const asset of assets) {
    const impact: ProposalImpact = {
      category,
      asset,
      severity,
    }

    // Add direction info
    if (nlp.direction !== 0) {
      impact.delta = nlp.direction > 0 ? '+1' : '-1'
    }

    // Add numerical values
    if (nlp.numericalValues) {
      impact.currentValue = nlp.numericalValues.current
      impact.proposedValue = nlp.numericalValues.proposed
    }

    impacts.push(impact)
  }

  return impacts
}
