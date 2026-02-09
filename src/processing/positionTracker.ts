/**
 * Unified position tracker.
 * Aggregates positions from dYdX, Aave, and Pendle into a single portfolio view.
 */
import { getReadClient } from '../clients/rpc.js'
import * as dydxClient from '../clients/dydx.js'
import * as pendleClient from '../clients/pendle.js'
import { aavePoolAbi } from '../config/abis/aavePool.js'
import { erc20DelegationAbi } from '../config/abis/erc20Delegation.js'
import { AAVE_V3 } from '../config/addresses.js'
import { eventBus } from '../lib/eventBus.js'
import { createLogger } from '../lib/logger.js'
import { upsertPosition, getPositions as getDbPositions } from '../lib/store.js'
import { formatTokenAmount } from '../lib/bignum.js'
import { config } from '../config/index.js'
import { sleep } from '../lib/retry.js'
import type { Position, Portfolio } from '../types/trading.js'

const log = createLogger('position-tracker')

let running = false
let walletAddress: string | null = null

// ─── Configuration ──────────────────────────────────────────────────

export function setWalletAddress(address: string): void {
  walletAddress = address
}

// ─── dYdX Positions ─────────────────────────────────────────────────

async function fetchDydxPositions(): Promise<Position[]> {
  if (!walletAddress) return []

  try {
    const positions = await dydxClient.getPositions(walletAddress)
    return positions.map((p) => ({
      id: `dydx:${p.market}`,
      protocol: 'dydx' as const,
      type: 'perp' as const,
      asset: p.market.replace('-USD', ''),
      size: p.side === 'SHORT' ? `-${p.size}` : p.size,
      entryPrice: p.entryPrice,
      currentPrice: '0', // Will be updated by price monitor
      unrealizedPnl: p.unrealizedPnl,
      realizedPnl: p.realizedPnl,
      accruedYield: p.netFunding,
      lastUpdated: new Date().toISOString(),
    }))
  } catch (err) {
    log.error({ err }, 'Failed to fetch dYdX positions')
    return []
  }
}

// ─── Aave Positions ─────────────────────────────────────────────────

async function fetchAavePositions(): Promise<Position[]> {
  if (!walletAddress) return []

  const client = getReadClient()
  const positions: Position[] = []

  try {
    const result = await client.readContract({
      address: AAVE_V3.pool as `0x${string}`,
      abi: aavePoolAbi,
      functionName: 'getUserAccountData',
      args: [walletAddress as `0x${string}`],
    }) as [bigint, bigint, bigint, bigint, bigint, bigint]

    const [totalCollateralBase, totalDebtBase, , , , healthFactor] = result

    // Aggregate Aave position
    if (totalCollateralBase > 0n || totalDebtBase > 0n) {
      const hf = Number(healthFactor) / 1e18

      if (totalCollateralBase > 0n) {
        positions.push({
          id: 'aave:collateral:aggregate',
          protocol: 'aave',
          type: 'lending_supply',
          asset: 'AGGREGATE',
          size: formatTokenAmount(totalCollateralBase, 8),
          entryPrice: '1',
          currentPrice: '1',
          unrealizedPnl: '0',
          realizedPnl: '0',
          accruedYield: '0',
          healthFactor: hf,
          lastUpdated: new Date().toISOString(),
        })
      }

      if (totalDebtBase > 0n) {
        positions.push({
          id: 'aave:debt:aggregate',
          protocol: 'aave',
          type: 'lending_borrow',
          asset: 'AGGREGATE',
          size: `-${formatTokenAmount(totalDebtBase, 8)}`,
          entryPrice: '1',
          currentPrice: '1',
          unrealizedPnl: '0',
          realizedPnl: '0',
          accruedYield: '0',
          healthFactor: hf,
          lastUpdated: new Date().toISOString(),
        })
      }
    }
  } catch (err) {
    log.error({ err }, 'Failed to fetch Aave positions')
  }

  return positions
}

// ─── Pendle Positions ───────────────────────────────────────────────

async function fetchPendlePositions(): Promise<Position[]> {
  if (!walletAddress) return []

  const positions: Position[] = []
  const client = getReadClient()

  try {
    // Get active Pendle markets
    const markets = await pendleClient.getActiveMarkets(1)

    for (const market of markets.slice(0, 10)) {
      // Check PT balance
      if (market.ptAddress) {
        try {
          const balance = await client.readContract({
            address: market.ptAddress as `0x${string}`,
            abi: erc20DelegationAbi, // balanceOf is standard ERC20
            functionName: 'balanceOf',
            args: [walletAddress as `0x${string}`],
          }) as bigint

          if (balance > 0n) {
            positions.push({
              id: `pendle:pt:${market.address}`,
              protocol: 'pendle',
              type: 'yield_pt',
              asset: market.name,
              size: formatTokenAmount(balance, 18),
              entryPrice: '0',
              currentPrice: '0',
              unrealizedPnl: '0',
              realizedPnl: '0',
              accruedYield: '0',
              maturity: market.expiry,
              lastUpdated: new Date().toISOString(),
            })
          }
        } catch {
          // Token may not support balanceOf — skip
        }
      }

      // Check YT balance
      if (market.ytAddress) {
        try {
          const balance = await client.readContract({
            address: market.ytAddress as `0x${string}`,
            abi: erc20DelegationAbi,
            functionName: 'balanceOf',
            args: [walletAddress as `0x${string}`],
          }) as bigint

          if (balance > 0n) {
            positions.push({
              id: `pendle:yt:${market.address}`,
              protocol: 'pendle',
              type: 'yield_yt',
              asset: market.name,
              size: formatTokenAmount(balance, 18),
              entryPrice: '0',
              currentPrice: '0',
              unrealizedPnl: '0',
              realizedPnl: '0',
              accruedYield: '0',
              maturity: market.expiry,
              lastUpdated: new Date().toISOString(),
            })
          }
        } catch {
          // skip
        }
      }
    }
  } catch (err) {
    log.error({ err }, 'Failed to fetch Pendle positions')
  }

  return positions
}

// ─── Aggregation ────────────────────────────────────────────────────

/**
 * Fetch all positions and aggregate into a portfolio.
 */
export async function refreshPositions(): Promise<Portfolio> {
  const [dydx, aave, pendle] = await Promise.all([
    fetchDydxPositions(),
    fetchAavePositions(),
    fetchPendlePositions(),
  ])

  const allPositions = [...dydx, ...aave, ...pendle]

  // Persist to SQLite
  for (const pos of allPositions) {
    upsertPosition({
      id: pos.id,
      protocol: pos.protocol,
      type: pos.type,
      asset: pos.asset,
      size: pos.size,
      entryPrice: pos.entryPrice,
      currentPrice: pos.currentPrice,
      unrealizedPnl: pos.unrealizedPnl,
      realizedPnl: pos.realizedPnl,
      accruedYield: pos.accruedYield,
      healthFactor: pos.healthFactor,
      maturity: pos.maturity,
    })
  }

  // Emit position update
  eventBus.emit('position:update', { positions: allPositions })

  const totalUnrealizedPnl = allPositions.reduce(
    (sum, p) => sum + parseFloat(p.unrealizedPnl || '0'),
    0,
  )
  const totalRealizedPnl = allPositions.reduce(
    (sum, p) => sum + parseFloat(p.realizedPnl || '0'),
    0,
  )
  const totalAccruedYield = allPositions.reduce(
    (sum, p) => sum + parseFloat(p.accruedYield || '0'),
    0,
  )

  return {
    positions: allPositions,
    totalValue: '0', // Requires price data
    totalUnrealizedPnl: totalUnrealizedPnl.toFixed(2),
    totalRealizedPnl: totalRealizedPnl.toFixed(2),
    totalAccruedYield: totalAccruedYield.toFixed(2),
    lastUpdated: new Date().toISOString(),
  }
}

// ─── Periodic Refresh Loop ──────────────────────────────────────────

async function refreshLoop(): Promise<void> {
  while (running) {
    try {
      const portfolio = await refreshPositions()
      log.info(
        { positions: portfolio.positions.length, unrealizedPnl: portfolio.totalUnrealizedPnl },
        'Position refresh complete',
      )
    } catch (err) {
      log.error({ err }, 'Position refresh error')
    }
    await sleep(30_000) // Refresh every 30s
  }
}

export function startPositionTracker(): void {
  running = true
  refreshLoop().catch((err) => log.error({ err }, 'Position tracker loop crashed'))
  log.info('Position tracker started')
}

export function stopPositionTracker(): void {
  running = false
  log.info('Position tracker stopped')
}
