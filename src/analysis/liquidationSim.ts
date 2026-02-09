/**
 * Liquidation simulator.
 * Estimates the impact of liquidation threshold changes on Aave V3 positions.
 */
import { getReadClient } from '../clients/rpc.js'
import { aavePoolAbi } from '../config/abis/aavePool.js'
import { AAVE_V3, APIS } from '../config/addresses.js'
import { computeHealthFactor, simulateHfAfterLtChange, hfLiquidationThreshold, bpsToPercent } from '../lib/bignum.js'
import { createLogger } from '../lib/logger.js'
import { withRetry } from '../lib/retry.js'
import { config } from '../config/index.js'
import type { LiquidationRisk, LiquidationSimResult, ParamChange } from '../types/protocol.js'

const log = createLogger('liquidation-sim')

// ─── On-Chain User Account Data ─────────────────────────────────────

interface UserAccountData {
  totalCollateralBase: bigint
  totalDebtBase: bigint
  availableBorrowsBase: bigint
  currentLiquidationThreshold: bigint
  ltv: bigint
  healthFactor: bigint
}

/**
 * Get aggregated account data for a user from Aave V3 Pool.
 */
export async function getUserAccountData(userAddress: string): Promise<UserAccountData> {
  const client = getReadClient()

  const result = await client.readContract({
    address: AAVE_V3.pool as `0x${string}`,
    abi: aavePoolAbi,
    functionName: 'getUserAccountData',
    args: [userAddress as `0x${string}`],
  }) as [bigint, bigint, bigint, bigint, bigint, bigint]

  return {
    totalCollateralBase: result[0],
    totalDebtBase: result[1],
    availableBorrowsBase: result[2],
    currentLiquidationThreshold: result[3],
    ltv: result[4],
    healthFactor: result[5],
  }
}

// ─── Subgraph Queries ───────────────────────────────────────────────

interface SubgraphUser {
  id: string
  healthFactor: string
  totalCollateralUSD: string
  totalDebtUSD: string
}

/**
 * Query Aave V3 subgraph for users near liquidation threshold.
 * Requires The Graph API key (free tier: 100K queries/month).
 */
async function queryUsersNearLiquidation(
  maxHf: number = 1.5,
  first: number = 100,
): Promise<SubgraphUser[]> {
  if (!config.theGraphApiKey) {
    log.warn('The Graph API key not configured — cannot query user positions')
    return []
  }

  const endpoint = `${APIS.theGraphGateway}/${config.theGraphApiKey}/subgraphs/id/${APIS.aaveV3SubgraphId}`

  const query = `{
    users(
      first: ${first},
      where: { borrowedReservesCount_gt: 0 },
      orderBy: healthFactor,
      orderDirection: asc
    ) {
      id
      healthFactor
      totalCollateralUSD
      totalDebtUSD
    }
  }`

  return withRetry(
    async () => {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })

      if (!res.ok) throw new Error(`Subgraph query failed: ${res.status}`)

      const data = (await res.json()) as { data: { users: SubgraphUser[] } }
      return (data.data.users ?? []).filter(
        (u) => parseFloat(u.healthFactor) > 0 && parseFloat(u.healthFactor) < maxHf,
      )
    },
    'subgraph-users-near-liq',
    { maxRetries: 2, baseDelayMs: 3000 },
  )
}

// ─── Simulation ─────────────────────────────────────────────────────

/**
 * Simulate the impact of a liquidation threshold change.
 *
 * For single-collateral positions:
 *   new_HF = old_HF * (new_LT / old_LT)
 *
 * Any position with old_HF < (old_LT / new_LT) becomes liquidatable.
 */
export async function simulateLtChange(
  oldLtBps: number,
  newLtBps: number,
  asset?: string,
): Promise<LiquidationSimResult> {
  const paramChange: ParamChange = {
    param: 'liquidationThreshold',
    oldValue: oldLtBps,
    newValue: newLtBps,
  }

  // Calculate the HF threshold below which positions become liquidatable
  const threshold = hfLiquidationThreshold(oldLtBps, newLtBps)

  log.info(
    {
      oldLt: bpsToPercent(oldLtBps),
      newLt: bpsToPercent(newLtBps),
      hfThreshold: threshold.toFixed(4),
    },
    'Simulating liquidation threshold change',
  )

  // Query users near liquidation from subgraph
  const users = await queryUsersNearLiquidation(threshold + 0.5)

  const risks: LiquidationRisk[] = []
  let totalAtRiskUsd = 0

  for (const user of users) {
    const currentHf = parseFloat(user.healthFactor)
    const newHf = simulateHfAfterLtChange(currentHf, oldLtBps, newLtBps)
    const atRisk = newHf < 1

    if (atRisk || newHf < 1.1) {
      risks.push({
        userAddress: user.id,
        healthFactor: currentHf,
        newHealthFactor: newHf,
        totalCollateralUsd: user.totalCollateralUSD,
        totalDebtUsd: user.totalDebtUSD,
        primaryCollateral: asset ?? 'unknown',
        atRisk,
      })

      if (atRisk) {
        totalAtRiskUsd += parseFloat(user.totalDebtUSD)
      }
    }
  }

  const result: LiquidationSimResult = {
    paramChange,
    affectedPositions: risks.filter((r) => r.atRisk).length,
    totalAtRiskUsd: totalAtRiskUsd.toFixed(2),
    liquidationRisks: risks.sort((a, b) => a.newHealthFactor - b.newHealthFactor),
  }

  log.info(
    {
      affectedPositions: result.affectedPositions,
      totalAtRiskUsd: result.totalAtRiskUsd,
    },
    'Liquidation simulation complete',
  )

  return result
}

/**
 * Quick estimate: how many positions are at risk without querying the subgraph.
 * Uses the mathematical relationship between old/new LT and current HF distribution.
 */
export function quickEstimate(
  oldLtBps: number,
  newLtBps: number,
): { threshold: number; description: string } {
  const threshold = hfLiquidationThreshold(oldLtBps, newLtBps)
  const oldPct = bpsToPercent(oldLtBps)
  const newPct = bpsToPercent(newLtBps)
  const changePct = ((newLtBps - oldLtBps) / oldLtBps) * 100

  return {
    threshold,
    description:
      `LT change from ${oldPct}% to ${newPct}% (${changePct > 0 ? '+' : ''}${changePct.toFixed(2)}%). ` +
      `Positions with HF < ${threshold.toFixed(4)} become liquidatable.`,
  }
}
