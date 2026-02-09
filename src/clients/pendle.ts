/**
 * Pendle API client.
 * Free, no API key. Rate limit: 100 CU/min, 200K CU/week.
 */
import { createLogger } from '../lib/logger.js'
import { withRetry, rateLimited } from '../lib/retry.js'
import { APIS } from '../config/addresses.js'
import type { PendleMarket } from '../types/protocol.js'
import type { PendleSwapParams } from '../types/trading.js'

const log = createLogger('pendle')

const BASE_URL = APIS.pendleApi

// Rate-limited fetch — conservative 1 req per 1.5s to stay within 100 CU/min
const pendleFetch = rateLimited(
  async (path: string): Promise<any> => {
    return withRetry(
      async () => {
        const res = await fetch(`${BASE_URL}${path}`)
        if (!res.ok) throw new Error(`Pendle API ${res.status}: ${path}`)
        return res.json()
      },
      `pendle:${path}`,
      { maxRetries: 2, baseDelayMs: 2000 },
    )
  },
  1500,
)

/**
 * Get all active Pendle markets on a chain.
 */
export async function getActiveMarkets(chainId: number = 1): Promise<PendleMarket[]> {
  const data = await pendleFetch(`/v1/${chainId}/markets/active`)

  if (!Array.isArray(data.results)) return []

  return data.results.map((m: any) => ({
    address: m.address,
    chainId: m.chainId,
    name: m.name,
    ptAddress: m.pt?.address ?? '',
    ytAddress: m.yt?.address ?? '',
    syAddress: m.sy?.address ?? '',
    underlyingAsset: m.underlyingAsset?.address ?? '',
    expiry: m.expiry,
    impliedApy: m.impliedApy ?? 0,
    underlyingApy: m.underlyingApy ?? 0,
    tvl: m.liquidity?.usd ?? 0,
    ptDiscount: m.ptDiscount ?? 0,
  }))
}

/**
 * Get data for a specific Pendle market.
 */
export async function getMarket(
  chainId: number,
  marketAddress: string,
): Promise<PendleMarket | null> {
  try {
    const m = await pendleFetch(`/v2/${chainId}/markets/${marketAddress}`)
    return {
      address: m.address,
      chainId: m.chainId,
      name: m.name,
      ptAddress: m.pt?.address ?? '',
      ytAddress: m.yt?.address ?? '',
      syAddress: m.sy?.address ?? '',
      underlyingAsset: m.underlyingAsset?.address ?? '',
      expiry: m.expiry,
      impliedApy: m.impliedApy ?? 0,
      underlyingApy: m.underlyingApy ?? 0,
      tvl: m.liquidity?.usd ?? 0,
      ptDiscount: m.ptDiscount ?? 0,
    }
  } catch (error) {
    log.error({ err: error, marketAddress }, 'Failed to fetch Pendle market')
    return null
  }
}

/**
 * Get swap calldata for a Pendle trade (PT or YT).
 * Uses the Pendle SDK API to generate ready-to-sign transaction data.
 */
export async function getSwapCalldata(params: PendleSwapParams): Promise<{
  tx: { to: string; data: string; value: string }
  amountOut: string
  priceImpact: number
} | null> {
  try {
    const qs = new URLSearchParams({
      receiver: params.receiver,
      slippage: params.slippage.toString(),
      tokensIn: params.tokenIn,
      tokensOut: params.tokenOut,
      amountsIn: params.amountIn,
      enableAggregator: 'true',
    })

    const data = await pendleFetch(`/v2/sdk/${params.chainId}/convert?${qs}`)

    if (!data.routes || data.routes.length === 0) {
      log.warn({ params }, 'No Pendle swap routes found')
      return null
    }

    const route = data.routes[0]
    return {
      tx: route.tx,
      amountOut: route.amountOut,
      priceImpact: route.priceImpact ?? 0,
    }
  } catch (error) {
    log.error({ err: error }, 'Failed to get Pendle swap calldata')
    return null
  }
}
