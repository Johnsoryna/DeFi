/**
 * Governance types — events, proposals, and impact analysis.
 */

// ─── Governance Stages ──────────────────────────────────────────────

export type GovernanceStage =
  | 'monitoring'
  | 'discussion'
  | 'snapshot'
  | 'onchain_vote'
  | 'timelock'
  | 'executed'
  | 'canceled'

// ─── Protocol Identifiers ───────────────────────────────────────────

export type GovernanceProtocol =
  | 'compound'
  | 'uniswap'
  | 'aave'
  | 'maker'
  | 'lido'
  | 'arbitrum'
  | 'curve'
  | 'synthetix'
  | 'dydx'
  | 'eigenlayer'
  | 'gmx'
  | 'morpho'
  | 'yearn'
  // ─── Removed (0 trades, no risk-parameter alpha) ──────────────────────
  // convex: gauge-weight emission votes (563 props, 0 trades confirmed)
  // optimism: L2 operational governance — all signals blocked by stablecoin-L2 filter
  // ethena: 0 trades; ENA cascade runs via COLLATERAL_ISSUER_TOKEN, no protocol entry needed
  // ens: treasury/delegate compensation governance
  // jupiter, celestia, avalanche, polygon, starknet, sui, sei, near: L1/L2 operational governance
  // cosmos, injective: losing trades (on-chain default OFF); no forum alpha
  // drift, jito, pyth: Solana operational/oracle/staking governance
  // 1inch: Fusion protocol operational governance
  // zksync, stacks: L2 operational governance (tested Mar 2026, 0 trades after 190+94 posts)
  // thegraph: team updates, council meetings — no risk-parameter alpha
  // euler: Gauntlet LLTV revisions = neutral NLP — 0 trades confirmed
  // pendle: no data source (DNS fail on forum, 0 proposals on pendle-politics.eth)
  // etherfi: treasury/buyback/seasonal rewards — 0 trades confirmed (Mar 2026)
  // wormhole: bridge delegate platforms + support tickets — 0 trades confirmed (Mar 2026)
  // mantle: no Binance USDT perp (delisted)
  // aptos, axelar, blur: no governance data, 0 trades
  // frax: 0 trades (re-tested Feb 2026 with body analysis, still 0; treasury governance)
  // balancer: no Binance USDT perp for BAL (delisted)
  // venus: 0 trades. Asset listing proposals, max confidence 0.50 (below 0.55 threshold)
  // rocketpool: 0 trades. Partnership/staking proposals, no risk-parameter alpha

// ─── Impact Categories ──────────────────────────────────────────────

export type ImpactCategory =
  | 'ltv_change'
  | 'liquidation_threshold_change'
  | 'supply_cap_change'
  | 'borrow_cap_change'
  | 'reserve_freeze'
  | 'interest_rate_change'
  | 'asset_listing'
  | 'asset_delisting'
  | 'oracle_change'
  | 'debt_ceiling_change'
  | 'reserve_factor_change'
  | 'emode_change'
  | 'stability_fee_change'
  | 'dsr_change'
  | 'other'

// ─── Governance Events ──────────────────────────────────────────────

export interface BaseGovernanceEvent {
  protocol: GovernanceProtocol
  blockNumber: bigint
  transactionHash: string
  logIndex: number
  timestamp?: number
  removed: boolean
}

export interface ProposalCreatedEvent extends BaseGovernanceEvent {
  type: 'proposal_created'
  proposalId: bigint
  proposer: string
  targets: string[]
  values: bigint[]
  signatures: string[]
  calldatas: string[]
  startBlock?: bigint
  endBlock?: bigint
  description: string
}

export interface VoteCastEvent extends BaseGovernanceEvent {
  type: 'vote_cast'
  proposalId: bigint
  voter: string
  support: number // 0 = against, 1 = for, 2 = abstain
  votes: bigint
  reason?: string
}

export interface ProposalQueuedEvent extends BaseGovernanceEvent {
  type: 'proposal_queued'
  proposalId: bigint
  eta?: bigint
  votesFor?: bigint
  votesAgainst?: bigint
}

export interface ProposalExecutedEvent extends BaseGovernanceEvent {
  type: 'proposal_executed'
  proposalId: bigint
}

export interface ProposalCanceledEvent extends BaseGovernanceEvent {
  type: 'proposal_canceled'
  proposalId: bigint
}

export interface MakerDSNoteEvent extends BaseGovernanceEvent {
  type: 'maker_dsnote'
  functionName: string // e.g. 'lock', 'free', 'vote', 'lift'
  caller: string
  rawData: string
}

export interface SnapshotProposalEvent {
  type: 'snapshot_proposal'
  protocol: GovernanceProtocol
  snapshotId: string
  title: string
  body: string
  choices: string[]
  start: number
  end: number
  snapshot: string
  state: string
  author: string
  scores: number[]
  scoresTotal: number
  space: string
}

export interface ForumPostEvent {
  type: 'forum_post'
  protocol: GovernanceProtocol
  forumUrl: string
  topicId: number
  title: string
  categoryId: number
  createdAt: string
  postsCount: number
  replyCount: number
  views: number
}

export interface DelegationChangeEvent extends BaseGovernanceEvent {
  type: 'delegation_change'
  token: string
  delegator: string
  fromDelegate: string
  toDelegate: string
}

export interface DelegateVotesChangedEvent extends BaseGovernanceEvent {
  type: 'delegate_votes_changed'
  token: string
  delegate: string
  previousBalance: bigint
  newBalance: bigint
}

export type GovernanceEvent =
  | ProposalCreatedEvent
  | VoteCastEvent
  | ProposalQueuedEvent
  | ProposalExecutedEvent
  | ProposalCanceledEvent
  | MakerDSNoteEvent
  | SnapshotProposalEvent
  | ForumPostEvent
  | DelegationChangeEvent
  | DelegateVotesChangedEvent

// ─── Decoded Proposal Action ────────────────────────────────────────

export interface DecodedAction {
  target: string
  signature: string
  params: Record<string, unknown>
  value: bigint
}

// ─── Proposal Analysis ──────────────────────────────────────────────

export interface ProposalAnalysis {
  proposalId: string
  protocol: GovernanceProtocol
  stage: GovernanceStage
  title: string
  description: string
  actions: DecodedAction[]
  impacts: ProposalImpact[]
  cascadeImpacts: CascadeImpact[]
  confidenceScore: number // 0-1
  timestamp: number
}

export interface ProposalImpact {
  category: ImpactCategory
  asset: string
  currentValue?: string
  proposedValue?: string
  delta?: string
  severity: 'low' | 'medium' | 'high' | 'critical'
}

export interface CascadeImpact {
  sourceNode: string
  affectedNode: string
  impactType: string
  estimatedEffect: string
  severity: 'low' | 'medium' | 'high' | 'critical'
}

// ─── Dynamic Proposal Types (Intelligence Engine) ────────────────────

export type ProposalType =
  | 'technical_parameter'   // LTV, Cap, Rate changes
  | 'asset_onboarding'      // Listings, new collaterals
  | 'protocol_deployment'   // Deploy on new chains, launch new products
  | 'treasury_funding'      // Committee funding, grants, service providers
  | 'governance_process'    // Legal, frameworks, voting rules
  | 'risk_mitigation'       // Freeze, deprecation, wind-down
  | 'infrastructure'        // Stewards, oracles, automation
  | 'economic_policy'       // Emissions, incentives, safety module

export type PriceImpactExpectation =
  | 'strong_positive'
  | 'positive'
  | 'neutral'
  | 'negative'
  | 'strong_negative'

export interface DynamicImpact {
  type: ProposalType
  affectedAssets: string[]
  affectedProtocols: string[]
  technicalCategory?: ImpactCategory
  expectedPriceImpact: PriceImpactExpectation
  tradingOpportunity: boolean
  confidence: number
  severity: 'low' | 'medium' | 'high' | 'critical'
  rationale: string
}

/**
 * Extended analysis with NLP-based classification.
 * Backward compatible with ProposalAnalysis (extends it).
 */
export interface IntelligentAnalysis extends ProposalAnalysis {
  proposalType: ProposalType
  dynamicImpacts: DynamicImpact[]
  nlpConfidence: number
  sentiment: 'bullish' | 'bearish' | 'neutral'
  extractedAssets: string[]
}

// ─── Tracked Proposal State ─────────────────────────────────────────

export interface TrackedProposal {
  id: string
  protocol: GovernanceProtocol
  stage: GovernanceStage
  title: string
  classification: ImpactCategory[]
  forVotes: string
  againstVotes: string
  createdAt: number
  updatedAt: number
  analysis?: ProposalAnalysis
}
