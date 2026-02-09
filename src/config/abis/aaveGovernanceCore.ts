/**
 * Aave V3 GovernanceCore ABI — governance proposal lifecycle events.
 */
export const aaveGovernanceCoreAbi = [
  {
    type: 'event',
    name: 'ProposalCreated',
    inputs: [
      { name: 'proposalId', type: 'uint256', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'accessLevel', type: 'uint8', indexed: true },
      { name: 'ipfsHash', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'VotingActivated',
    inputs: [
      { name: 'proposalId', type: 'uint256', indexed: true },
      { name: 'snapshotBlockHash', type: 'bytes32', indexed: false },
      { name: 'votingDuration', type: 'uint24', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ProposalQueued',
    inputs: [
      { name: 'proposalId', type: 'uint256', indexed: true },
      { name: 'votesFor', type: 'uint128', indexed: false },
      { name: 'votesAgainst', type: 'uint128', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ProposalExecuted',
    inputs: [
      { name: 'proposalId', type: 'uint256', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'ProposalCanceled',
    inputs: [
      { name: 'proposalId', type: 'uint256', indexed: true },
    ],
  },
  {
    type: 'function',
    name: 'getProposal',
    stateMutability: 'view',
    inputs: [{ name: 'proposalId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'id', type: 'uint256' },
          { name: 'state', type: 'uint8' },
          { name: 'creator', type: 'address' },
          { name: 'accessLevel', type: 'uint8' },
          { name: 'votingDuration', type: 'uint24' },
          { name: 'creationTime', type: 'uint40' },
          { name: 'votingActivationTime', type: 'uint40' },
          { name: 'queuingTime', type: 'uint40' },
          { name: 'cancelTimestamp', type: 'uint40' },
          { name: 'ipfsHash', type: 'bytes32' },
          { name: 'votesFor', type: 'uint128' },
          { name: 'votesAgainst', type: 'uint128' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'getProposalsCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const
