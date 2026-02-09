/**
 * Curve GaugeController ABI — gauge weight queries.
 */
export const curveGaugeControllerAbi = [
  {
    type: 'function',
    name: 'n_gauges',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'int128' }],
  },
  {
    type: 'function',
    name: 'gauges',
    stateMutability: 'view',
    inputs: [{ name: 'i', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'gauge_relative_weight',
    stateMutability: 'view',
    inputs: [
      { name: 'addr', type: 'address' },
      { name: 'time', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'gauge_relative_weight',
    stateMutability: 'view',
    inputs: [{ name: 'addr', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'get_gauge_weight',
    stateMutability: 'view',
    inputs: [{ name: 'addr', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const
