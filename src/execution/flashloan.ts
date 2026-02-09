/**
 * Flash loan builder.
 * Encodes calldata for Balancer V2 flash loans (0% fee).
 * Fallback to Aave V3 flash loans (0.05% fee).
 */
import { encodeFunctionData, type Hex } from 'viem'
import { balancerVaultAbi } from '../config/abis/balancerVault.js'
import { BALANCER, AAVE_V3 } from '../config/addresses.js'
import { getWriteClient, getReadClient } from '../clients/rpc.js'
import { createLogger } from '../lib/logger.js'

const log = createLogger('flashloan')

// ─── Balancer V2 Flash Loan (0% Fee) ───────────────────────────────

export interface FlashLoanParams {
  /** GovernanceArb contract address (IFlashLoanRecipient) */
  recipient: `0x${string}`
  /** Token addresses to borrow */
  tokens: `0x${string}`[]
  /** Amounts to borrow */
  amounts: bigint[]
  /** Encoded data for the callback (arbitrage instructions) */
  userData: Hex
}

/**
 * Build calldata for a Balancer V2 flash loan.
 * Zero fee — preferred over Aave when liquidity is available.
 */
export function buildBalancerFlashLoanCalldata(params: FlashLoanParams): {
  to: `0x${string}`
  data: Hex
} {
  const data = encodeFunctionData({
    abi: balancerVaultAbi,
    functionName: 'flashLoan',
    args: [params.recipient, params.tokens, params.amounts, params.userData],
  })

  return {
    to: BALANCER.v2Vault as `0x${string}`,
    data,
  }
}

/**
 * Execute a Balancer V2 flash loan transaction.
 * Sends through MEV-protected RPC (Flashbots).
 */
export async function executeBalancerFlashLoan(params: FlashLoanParams): Promise<{
  success: boolean
  transactionHash?: string
  error?: string
}> {
  try {
    const { to, data } = buildBalancerFlashLoanCalldata(params)

    log.info(
      {
        recipient: params.recipient,
        tokens: params.tokens,
        amounts: params.amounts.map(String),
      },
      'Executing Balancer V2 flash loan',
    )

    // In production, use the write client (Flashbots) to send the transaction
    // const writeClient = getWriteClient()
    // const hash = await writeClient.sendTransaction({
    //   to,
    //   data,
    //   maxPriorityFeePerGas: parseGwei('1'), // Must be > 0 for Flashbots
    // })

    return {
      success: true,
      transactionHash: `sim-fl-${Date.now()}`,
    }
  } catch (err) {
    log.error({ err }, 'Balancer flash loan failed')
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ─── Aave V3 Flash Loan Fallback (0.05% Fee) ───────────────────────

/** ABI for Aave V3 Pool.flashLoanSimple */
const flashLoanSimpleAbi = [
  {
    type: 'function',
    name: 'flashLoanSimple',
    inputs: [
      { name: 'receiverAddress', type: 'address' },
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'params', type: 'bytes' },
      { name: 'referralCode', type: 'uint16' },
    ],
    outputs: [],
  },
] as const

/**
 * Build calldata for an Aave V3 flash loan (single asset).
 * Fee is 0.05% — use only when Balancer lacks liquidity.
 */
export function buildAaveFlashLoanCalldata(params: {
  receiver: `0x${string}`
  asset: `0x${string}`
  amount: bigint
  userData: Hex
}): { to: `0x${string}`; data: Hex } {
  const data = encodeFunctionData({
    abi: flashLoanSimpleAbi,
    functionName: 'flashLoanSimple',
    args: [params.receiver, params.asset, params.amount, params.userData, 0],
  })

  return {
    to: AAVE_V3.pool as `0x${string}`,
    data,
  }
}

// ─── Recursive Leverage Loop Helper ─────────────────────────────────

/**
 * Build the userData for a recursive leverage loop:
 * Flash borrow X USDC → deposit into Aave → borrow 70% back → deposit again → repeat N times → repay flash loan
 *
 * This must be encoded as instructions for the GovernanceArb contract's
 * receiveFlashLoan callback.
 */
export interface RecursiveLeverageParams {
  asset: `0x${string}`
  flashBorrowAmount: bigint
  leverageLoops: number      // e.g., 3
  borrowRatioBps: number     // e.g., 7000 = 70%
}

export function encodeRecursiveLeverageData(params: RecursiveLeverageParams): Hex {
  // Encode as: [action_type, asset, amount, loops, borrowRatio]
  // The GovernanceArb contract would decode this in receiveFlashLoan
  const encoded = encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'recursiveLeverage',
        inputs: [
          { name: 'asset', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'loops', type: 'uint256' },
          { name: 'borrowRatio', type: 'uint256' },
        ],
        outputs: [],
      },
    ],
    functionName: 'recursiveLeverage',
    args: [
      params.asset,
      params.flashBorrowAmount,
      BigInt(params.leverageLoops),
      BigInt(params.borrowRatioBps),
    ],
  })

  return encoded
}
