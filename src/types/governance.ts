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

// ─── Protocol Identifiers ───────────────────────────────────────────

export type GovernanceProtocol = 'compound' | 'uniswap' | 'aave' | 'maker'

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
