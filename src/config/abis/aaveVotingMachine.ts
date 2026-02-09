/**
 * Aave V3 VotingMachine ABI — vote events.
 */
export const aaveVotingMachineAbi = [
  {
    type: 'event',
    name: 'VoteEmitted',
    inputs: [
      { name: 'proposalId', type: 'uint256', indexed: true },
      { name: 'voter', type: 'address', indexed: true },
      { name: 'support', type: 'bool', indexed: true },
      { name: 'votingPower', type: 'uint248', indexed: false },
    ],
  },
] as const
