/**
 * DefiLlama API client.
 *
 * IMPORTANT (verified Feb 2026): ALL /yields/* endpoints (pools, charts,
 * borrow rates, perps, LSD rates) are behind a $300/month paywall.
 * Pro tier: 1,000 req/min, 1M calls/month ($300/mo).
 *
 * This client uses ONLY the free endpoints:
 *   - TVL:    /api/protocols, /api/protocol/{slug}, /api/tvl/{protocol}
 *   - Prices: /coins/prices/current/{coins}, /coins/prices/historical/{ts}/{coins}
 *
 * Free tier rate limit: undocumented but exists (will get 429 if exceeded).
 * Our usage: ~1 price call every 30s + occasional TVL lookups = well within limits.
 *
 * APY/yield data is computed from on-chain reserve data instead.
 */
import { createLogger } from '../lib/logger.js'
import { withRetry } from '../lib/retry.js'
import { APIS } from '../config/addresses.js'

const _log = createLogger('defillama')

// ─── TVL Endpoints ──────────────────────────────────────────────────

export interface ProtocolTvl {
  name: string
  slug: string
  tvl: number
  chainTvls: Record<string, number>
  change_1d: number | null
  change_7d: number | null
}

/**
 * Get all protocols with current TVL.
 */
export async function getAllProtocols(): Promise<ProtocolTvl[]> {
  return withRetry(
    async () => {
      const res = await fetch(APIS.defiLlamaProtocols)
      if (!res.ok) throw new Error(`DefiLlama protocols ${res.status}`)
      return (await res.json()) as ProtocolTvl[]
    },
    'defillama-protocols',
    { maxRetries: 2, baseDelayMs: 3000 },
  )
}

/**
 * Get detailed TVL data for a specific protocol.
 */
export async function getProtocolDetail(slug: string): Promise<unknown> {
  return withRetry(
    async () => {
      const res = await fetch(`https://api.llama.fi/protocol/${slug}`)
      if (!res.ok) throw new Error(`DefiLlama protocol ${res.status}: ${slug}`)
      return res.json()
    },
    `defillama-protocol-${slug}`,
    { maxRetries: 2, baseDelayMs: 3000 },
  )
}

/**
 * Get simple current TVL for a protocol.
 */
export async function getTvl(slug: string): Promise<number> {
  return withRetry(
    async () => {
      const res = await fetch(`${APIS.defiLlamaTvl}/${slug}`)
      if (!res.ok) throw new Error(`DefiLlama TVL ${res.status}: ${slug}`)
      return (await res.json()) as number
    },
    `defillama-tvl-${slug}`,
    { maxRetries: 2, baseDelayMs: 3000 },
  )
}

// ─── Price Endpoints ────────────────────────────────────────────────

export interface TokenPrice {
  price: number
  symbol: string
  timestamp: number
  confidence: number
}

/**
 * Get current prices for multiple tokens.
 * Format: "ethereum:0xaddr,ethereum:0xaddr2"
 */
export async function getCurrentPrices(
  coins: string[],
): Promise<Record<string, TokenPrice>> {
  const coinsStr = coins.join(',')
  return withRetry(
    async () => {
      const res = await fetch(`${APIS.defiLlamaPrices}/${coinsStr}`)
      if (!res.ok) throw new Error(`DefiLlama prices ${res.status}`)
      const data = (await res.json()) as { coins: Record<string, TokenPrice> }
      return data.coins
    },
    'defillama-prices',
    { maxRetries: 2, baseDelayMs: 3000 },
  )
}

/**
 * Get historical prices for multiple tokens at a specific timestamp.
 */
export async function getHistoricalPrices(
  timestamp: number,
  coins: string[],
): Promise<Record<string, TokenPrice>> {
  const coinsStr = coins.join(',')
  return withRetry(
    async () => {
      const res = await fetch(`${APIS.defiLlamaPricesHistorical}/${timestamp}/${coinsStr}`)
      if (!res.ok) throw new Error(`DefiLlama historical prices ${res.status}`)
      const data = (await res.json()) as { coins: Record<string, TokenPrice> }
      return data.coins
    },
    'defillama-historical-prices',
    { maxRetries: 2, baseDelayMs: 3000 },
  )
}

// ─── Helper ─────────────────────────────────────────────────────────

/**
 * Build a DefiLlama coin identifier from chain and address.
 * Example: buildCoinId('ethereum', '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9')
 */
export function buildCoinId(chain: string, address: string): string {
  return `${chain}:${address}`
}
