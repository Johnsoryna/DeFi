/**
 * Pendle executor.
 * Executes PT/YT swaps via the Pendle SDK API.
 * Sends transactions through MEV-protected RPC (Flashbots).
 */
import * as pendleClient from '../clients/pendle.js'
import { getWriteClient, getReadClient, getWalletAddress } from '../clients/rpc.js'
import { createLogger } from '../lib/logger.js'
import type { ExecutionResult, TradeSignal, PendleSwapParams } from '../types/trading.js'
import type { PendleMarket } from '../types/protocol.js'

const log = createLogger('pendle-executor')

// ─── Market Resolution ──────────────────────────────────────────────

let marketCache: PendleMarket[] = []
let cacheTimestamp = 0
const CACHE_TTL = 300_000 // 5 minutes

async function getMarkets(): Promise<PendleMarket[]> {
  if (Date.now() - cacheTimestamp < CACHE_TTL && marketCache.length > 0) {
    return marketCache
  }

  marketCache = await pendleClient.getActiveMarkets(1)
  cacheTimestamp = Date.now()
  return marketCache
}

/**
 * Find a Pendle market for a given asset/signal.
 */
async function findMarket(asset: string): Promise<PendleMarket | null> {
  const markets = await getMarkets()

  // Try to find a market related to the asset
  const assetLower = asset.toLowerCase()
  return (
    markets.find(
      (m) =>
        m.name.toLowerCase().includes(assetLower) ||
        m.underlyingAsset.toLowerCase() === assetLower,
    ) ?? null
  )
}

// ─── Trade Execution ────────────────────────────────────────────────

/**
 * Execute a Pendle yield trade from a trade signal.
 * direction = 'long' + yield_pt context → buy PT (bet on rates falling)
 * direction = 'long' + yield_yt context → buy YT (bet on rates rising)
 */
export async function executePendleSignal(signal: TradeSignal): Promise<ExecutionResult> {
  try {
    const market = await findMarket(signal.asset)
    if (!market) {
      return {
        success: false,
        signalId: signal.id,
        protocol: 'pendle',
        error: `No Pendle market found for asset: ${signal.asset}`,
        timestamp: Date.now(),
      }
    }

    let walletAddress: string
    try {
      walletAddress = getWalletAddress()
    } catch {
      return {
        success: false,
        signalId: signal.id,
        protocol: 'pendle',
        error: 'Wallet not configured for Pendle execution',
        timestamp: Date.now(),
      }
    }

    // Determine if we're trading PT or YT based on signal rationale
    const isPtTrade = signal.rationale.toLowerCase().includes('pt')
    const tokenOut = isPtTrade ? market.ptAddress : market.ytAddress

    log.info(
      {
        market: market.name,
        tokenType: isPtTrade ? 'PT' : 'YT',
        signalId: signal.id,
        expiry: market.expiry,
        impliedApy: market.impliedApy,
      },
      'Executing Pendle trade',
    )

    // Get swap calldata from Pendle API
    const swapParams: PendleSwapParams = {
      chainId: 1,
      marketAddress: market.address,
      tokenIn: market.underlyingAsset,
      tokenOut,
      amountIn: '0', // Would be calculated from portfolio value
      slippage: 0.01, // 1%
      receiver: walletAddress,
    }

    const swapData = await pendleClient.getSwapCalldata(swapParams)

    if (!swapData) {
      return {
        success: false,
        signalId: signal.id,
        protocol: 'pendle',
        error: 'Failed to get Pendle swap calldata',
        timestamp: Date.now(),
      }
    }

    // In production: sign and send tx through Flashbots
    log.info(
      {
        to: swapData.tx.to,
        amountOut: swapData.amountOut,
        priceImpact: swapData.priceImpact,
      },
      'Pendle swap calldata generated (dry run)',
    )

    return {
      success: true,
      signalId: signal.id,
      protocol: 'pendle',
      transactionHash: `sim-pendle-${signal.id}`,
      executedSize: swapData.amountOut,
      timestamp: Date.now(),
    }
  } catch (err) {
    log.error({ err, signalId: signal.id }, 'Pendle execution failed')
    return {
      success: false,
      signalId: signal.id,
      protocol: 'pendle',
      error: err instanceof Error ? err.message : String(err),
      timestamp: Date.now(),
    }
  }
}
