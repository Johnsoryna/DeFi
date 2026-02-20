/**
 * Unified position tracker.
 * Aggregates positions from Binance Futures and Aave into a single portfolio view.
 */
import { getReadClient } from '../clients/rpc.js'
import * as binanceClient from '../clients/binance.js'
import { aavePoolAbi } from '../config/abis/aavePool.js'
import { AAVE_V3 } from '../config/addresses.js'
import { eventBus } from '../lib/eventBus.js'
import { createLogger } from '../lib/logger.js'
import { upsertPosition } from '../lib/store.js'
import { formatTokenAmount } from '../lib/bignum.js'
import { sleep } from '../lib/retry.js'
import type { Position, Portfolio } from '../types/trading.js'

const log = createLogger('position-tracker')

let running = false
let refreshing = false // Mutex to prevent overlapping refreshes
let walletAddress: string | null = null

// ─── Configuration ──────────────────────────────────────────────────

export function setWalletAddress(address: string): void {
  walletAddress = address
}

// ─── Binance Futures Positions ───────────────────────────────────────

async function fetchBinancePositions(): Promise<Position[]> {
  try {
    const positions = await binanceClient.getPositions()
    return positions.map((p) => ({
      id: `binance:${p.symbol}`,
      protocol: 'binance' as const,
      type: 'perp' as const,
      asset: p.symbol.replace('USDT', ''),
      size: p.positionAmt,
      entryPrice: p.entryPrice,
      currentPrice: p.markPrice,
      unrealizedPnl: p.unrealizedProfit,
      realizedPnl: '0',
      accruedYield: '0',
      leverage: parseInt(p.leverage, 10),
      lastUpdated: new Date().toISOString(),
    }))
  } catch (err) {
    log.error({ err }, 'Failed to fetch Binance positions')
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

// ─── Aggregation ────────────────────────────────────────────────────

/**
 * Fetch all positions and aggregate into a portfolio.
 */
export async function refreshPositions(): Promise<Portfolio> {
  const [binance, aave] = await Promise.all([
    fetchBinancePositions(),
    fetchAavePositions(),
  ])

  const allPositions = [...binance, ...aave]

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
  const totalValue = allPositions.reduce(
    (sum, p) => {
      const size = Math.abs(parseFloat(p.size || '0'))
      const price = parseFloat(p.currentPrice || '0')
      return sum + size * price
    },
    0,
  )

  return {
    positions: allPositions,
    totalValue: totalValue.toFixed(2),
    totalUnrealizedPnl: totalUnrealizedPnl.toFixed(2),
    totalRealizedPnl: totalRealizedPnl.toFixed(2),
    totalAccruedYield: totalAccruedYield.toFixed(2),
    lastUpdated: new Date().toISOString(),
  }
}

// ─── Periodic Refresh Loop ──────────────────────────────────────────

async function refreshLoop(): Promise<void> {
  while (running) {
    // Mutex: skip if previous refresh is still running (prevents overlapping state)
    if (!refreshing) {
      refreshing = true
      try {
        const portfolio = await refreshPositions()
        log.info(
          { positions: portfolio.positions.length, unrealizedPnl: portfolio.totalUnrealizedPnl },
          'Position refresh complete',
        )
      } catch (err) {
        log.error({ err }, 'Position refresh error')
      } finally {
        refreshing = false
      }
    }
    await sleep(30_000) // Refresh every 30s
  }
}

export function startPositionTracker(): void {
  running = true
  function startRefreshLoop() {
    refreshLoop().catch((err) => {
      log.error({ err }, 'Position tracker loop crashed, restarting in 10s')
      if (running) setTimeout(startRefreshLoop, 10_000)
    })
  }
  startRefreshLoop()
  log.info('Position tracker started')
}

export function stopPositionTracker(): void {
  running = false
  log.info('Position tracker stopped')
}
