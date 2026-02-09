/**
 * MakerDAO DSChief ABI — executive voting.
 * DSNote events are anonymous with topic0 = function selector.
 */
export const dsChiefAbi = [
  // Non-anonymous event
  {
    type: 'event',
    name: 'Etch',
    inputs: [{ name: 'slate', type: 'bytes32', indexed: true }],
  },
  // Read functions
  {
    type: 'function',
    name: 'hat',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'approvals',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'deposits',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'slates',
    stateMutability: 'view',
    inputs: [
      { name: '', type: 'bytes32' },
      { name: '', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'address' }],
  },
  // Write functions (for decoding calldata)
  {
    type: 'function',
    name: 'lock',
    inputs: [{ name: 'wad', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'free',
    inputs: [{ name: 'wad', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'vote',
    inputs: [{ name: 'yays', type: 'address[]' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'vote',
    inputs: [{ name: 'slate', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'lift',
    inputs: [{ name: 'whom', type: 'address' }],
    outputs: [],
  },
] as const
