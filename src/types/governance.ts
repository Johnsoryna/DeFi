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
  | 'optimism'
  | 'synthetix'
  | 'dydx'
  | 'ethena'
  | 'eigenlayer'
  | 'ens'
  | 'gmx'
  | 'jupiter'
  | 'celestia'
  | 'avalanche'
  | 'polygon'
  | 'starknet'
  | 'morpho'
  | 'sui'
  | 'mantle'
  | 'sei'
  // ─── New Tier A protocols (dYdX vol >$5K/day) ──────────
  | 'cosmos'        // ATOM — $301K vol
  | 'aptos'         // APT — $62K vol
  | 'axelar'        // AXL — $57K vol
  | 'near'          // NEAR — $53K vol
  | 'injective'     // INJ — $35K vol
  | 'blur'          // BLUR — $31K vol
  | 'jito'          // JTO — $28K vol
  | 'zksync'        // ZK — $19K vol
  | 'drift'         // DRIFT — $19K vol
  | 'pyth'          // PYTH — $8K vol
  | 'stacks'        // STX — $12K vol
  | '1inch'
  | 'yearn'
  | 'convex'
  // balancer: REMOVED — no Binance USDT perp for BAL
  // venus: TESTED — 0 trades. Asset listing proposals, max confidence 0.50 (below 0.55 threshold).
  // rocketpool: TESTED — 0 trades. Partnership/staking proposals, no risk-parameter alpha.
  | 'pendle'        // PENDLE — yield tokenization protocol, yield pool risk params
  | 'thegraph'      // GRT — indexer slashing, query fees, protocol economics
  | 'euler'         // EUL — Euler Finance, AAVE-like lending with monthly risk updates (Gauntlet)

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
