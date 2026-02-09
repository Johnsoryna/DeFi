/**
 * Compound V3 Comet ABI — asset configuration queries.
 */
export const compoundCometAbi = [
  {
    type: 'function',
    name: 'numAssets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'getAssetInfo',
    stateMutability: 'view',
    inputs: [{ name: 'i', type: 'uint8' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'offset', type: 'uint8' },
          { name: 'asset', type: 'address' },
          { name: 'priceFeed', type: 'address' },
          { name: 'scale', type: 'uint64' },
          { name: 'borrowCollateralFactor', type: 'uint64' },
          { name: 'liquidateCollateralFactor', type: 'uint64' },
          { name: 'liquidationFactor', type: 'uint64' },
          { name: 'supplyCap', type: 'uint128' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'getUtilization',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getSupplyRate',
    stateMutability: 'view',
    inputs: [{ name: 'utilization', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'getBorrowRate',
    stateMutability: 'view',
    inputs: [{ name: 'utilization', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalBorrow',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

/**
 * Compound V3 Configurator ABI — governance-controlled parameter functions.
 */
export const compoundConfiguratorAbi = [
  {
    type: 'function',
    name: 'updateAssetBorrowCollateralFactor',
    inputs: [
      { name: 'cometProxy', type: 'address' },
      { name: 'asset', type: 'address' },
      { name: 'newBorrowCF', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'updateAssetLiquidateCollateralFactor',
    inputs: [
      { name: 'cometProxy', type: 'address' },
      { name: 'asset', type: 'address' },
      { name: 'newLiquidateCF', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'updateAssetSupplyCap',
    inputs: [
      { name: 'cometProxy', type: 'address' },
      { name: 'asset', type: 'address' },
      { name: 'newSupplyCap', type: 'uint128' },
    ],
    outputs: [],
  },
] as const
