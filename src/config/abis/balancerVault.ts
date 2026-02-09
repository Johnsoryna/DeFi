/**
 * Balancer V2 Vault ABI — flash loan interface (0% fee).
 */
export const balancerVaultAbi = [
  {
    type: 'function',
    name: 'flashLoan',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'recipient', type: 'address' },
      { name: 'tokens', type: 'address[]' },
      { name: 'amounts', type: 'uint256[]' },
      { name: 'userData', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getProtocolFeesCollector',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const

/**
 * IFlashLoanRecipient interface — implemented by our GovernanceArb contract.
 */
export const flashLoanRecipientAbi = [
  {
    type: 'function',
    name: 'receiveFlashLoan',
    inputs: [
      { name: 'tokens', type: 'address[]' },
      { name: 'amounts', type: 'uint256[]' },
      { name: 'feeAmounts', type: 'uint256[]' },
      { name: 'userData', type: 'bytes' },
    ],
    outputs: [],
  },
] as const
