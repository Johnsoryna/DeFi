/**
 * Aave V3 PoolConfigurator ABI — governance-controlled risk parameter functions.
 * Used for proposal action classification.
 */
export const aavePoolConfiguratorAbi = [
  {
    type: 'function',
    name: 'configureReserveAsCollateral',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'ltv', type: 'uint256' },
      { name: 'liquidationThreshold', type: 'uint256' },
      { name: 'liquidationBonus', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setBorrowCap',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'newBorrowCap', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setSupplyCap',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'newSupplyCap', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setReserveFreeze',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'freeze', type: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setDebtCeiling',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'newDebtCeiling', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setReserveFactor',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'newReserveFactor', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setEModeCategory',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'categoryId', type: 'uint8' },
      { name: 'ltv', type: 'uint16' },
      { name: 'liquidationThreshold', type: 'uint16' },
      { name: 'liquidationBonus', type: 'uint16' },
      { name: 'oracle', type: 'address' },
      { name: 'label', type: 'string' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setSiloedBorrowing',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'newSiloed', type: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setReservePause',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'paused', type: 'bool' },
    ],
    outputs: [],
  },
] as const
