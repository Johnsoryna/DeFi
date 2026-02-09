/**
 * Event signatures and topic0 hashes for all monitored governance contracts.
 */

// ─── Governor Bravo Events (Compound + Uniswap) ─────────────────────

export const GOVERNOR_BRAVO_EVENTS = {
  ProposalCreated: {
    signature:
      'ProposalCreated(uint256,address,address[],uint256[],string[],bytes[],uint256,uint256,string)',
    topic0: '0x7d84a6263ae0d98d3329bd7b46bb4e8d6f98cd35a7adb45c274c8b7fd5ebd5e0',
  },
  VoteCast: {
    signature: 'VoteCast(address,uint256,uint8,uint256,string)',
    topic0: '0xb8e138887d0aa13bab447e82de9d5c1777041ecd21ca36ba824ff1e6c07ddda4',
  },
  ProposalQueued: {
    signature: 'ProposalQueued(uint256,uint256)',
    topic0: '0x9a2e42fd6722813d69113e7d0079d3d940171428df7373df9c7f7617cfda2892',
  },
  ProposalExecuted: {
    signature: 'ProposalExecuted(uint256)',
    topic0: '0x712ae1383f79ac853f8d882153778e0260ef8f03b504e2a0b87b6d0a92311534',
  },
} as const

// ─── Aave V3 Governance Events ───────────────────────────────────────
// Exact topic0 hashes should be verified from the GovernanceCore verified source.
// These are the event names; signatures encoded below.

export const AAVE_GOVERNANCE_EVENTS = {
  ProposalCreated: {
    name: 'ProposalCreated',
  },
  VotingActivated: {
    name: 'VotingActivated',
  },
  ProposalQueued: {
    name: 'ProposalQueued',
  },
  ProposalExecuted: {
    name: 'ProposalExecuted',
  },
} as const

export const AAVE_VOTING_MACHINE_EVENTS = {
  VoteEmitted: {
    name: 'VoteEmitted',
    // VoteEmitted(uint256 proposalId, address voter, bool support, uint248 votingPower)
  },
} as const

// ─── MakerDAO DSNote Function Selectors (act as topic0) ─────────────
// DSNote is an anonymous event where topic0 = function selector (left-padded to 32 bytes).

export const MAKER_DSNOTE_SELECTORS = {
  lock: '0xdd467064' as const,    // lock(uint256)
  free: '0xd8ccd0f3' as const,    // free(uint256)
  voteArray: '0xed081329' as const, // vote(address[])
  voteSlate: '0xa69beaba' as const, // vote(bytes32)
  lift: '0x3c278bd5' as const,     // lift(address)
} as const

/** Padded to 32 bytes for topic0 matching in eth_getLogs */
export const MAKER_DSNOTE_TOPICS = Object.values(MAKER_DSNOTE_SELECTORS).map(
  (sel) => (sel + '0'.repeat(56)) as `0x${string}`
)

// ─── Delegation Events (ERC20Votes / Comp-style) ─────────────────────

export const DELEGATION_EVENTS = {
  DelegateChanged: {
    signature: 'DelegateChanged(address,address,address)',
    topic0: '0x3134e8a2e6d97e929a7e54011ea5485d7d196dd5f0ba4d4ef95803e8e3fc257f',
  },
  DelegateVotesChanged: {
    signature: 'DelegateVotesChanged(address,uint256,uint256)',
    topic0: '0xDEC2BACDD2F05B59de34da9b523dff8be42e5e38e818c82fdb0bae774387a724',
  },
} as const
