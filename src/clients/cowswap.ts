/**
 * CowSwap API client.
 * Free, no API key, MEV-protected by design (batch auction model).
 * Uses intent-based EIP-712 signed orders.
 */
import { createLogger } from '../lib/logger.js'
import { withRetry } from '../lib/retry.js'
import { APIS } from '../config/addresses.js'
import type { DexSwapParams } from '../types/trading.js'

const log = createLogger('cowswap')

const BASE_URL = `${APIS.cowswap}/mainnet/api/v1`

// ─── Types ──────────────────────────────────────────────────────────

export interface CowQuote {
  quote: {
    sellToken: string
    buyToken: string
    sellAmount: string
    buyAmount: string
    feeAmount: string
    validTo: number
    kind: string
    partiallyFillable: boolean
    receiver: string
  }
  from: string
  id: number
}

export interface CowOrderResult {
  uid: string
}

// ─── API Methods ────────────────────────────────────────────────────

/**
 * Get a price quote from CowSwap.
 */
export async function getQuote(params: {
  sellToken: string
  buyToken: string
  sellAmountBeforeFee: string
  from: string
  receiver: string
  kind?: 'sell' | 'buy'
}): Promise<CowQuote> {
  return withRetry(
    async () => {
      const res = await fetch(`${BASE_URL}/quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sellToken: params.sellToken,
          buyToken: params.buyToken,
          sellAmountBeforeFee: params.sellAmountBeforeFee,
          from: params.from,
          receiver: params.receiver,
          kind: params.kind ?? 'sell',
          appData: '0x0000000000000000000000000000000000000000000000000000000000000000',
          appDataHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
        }),
      })

      if (!res.ok) {
        const body = await res.text()
        throw new Error(`CowSwap quote error ${res.status}: ${body}`)
      }

      return (await res.json()) as CowQuote
    },
    'cowswap-quote',
    { maxRetries: 2, baseDelayMs: 2000 },
  )
}

/**
 * Submit a signed order to CowSwap.
 * The order must be EIP-712 signed by the user's wallet.
 */
export async function submitOrder(signedOrder: {
  sellToken: string
  buyToken: string
  sellAmount: string
  buyAmount: string
  validTo: number
  feeAmount: string
  kind: string
  partiallyFillable: boolean
  receiver: string
  signature: string
  signingScheme: string
  from: string
  appData: string
  appDataHash: string
}): Promise<string> {
  return withRetry(
    async () => {
      const res = await fetch(`${BASE_URL}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signedOrder),
      })

      if (!res.ok) {
        const body = await res.text()
        throw new Error(`CowSwap order error ${res.status}: ${body}`)
      }

      const uid = (await res.json()) as string
      log.info({ uid }, 'CowSwap order submitted')
      return uid
    },
    'cowswap-order',
    { maxRetries: 1, baseDelayMs: 2000 },
  )
}

/**
 * Check order status.
 */
export async function getOrderStatus(uid: string): Promise<any> {
  return withRetry(
    async () => {
      const res = await fetch(`${BASE_URL}/orders/${uid}`)
      if (!res.ok) throw new Error(`CowSwap order status error: ${res.status}`)
      return res.json()
    },
    'cowswap-status',
    { maxRetries: 2, baseDelayMs: 1000 },
  )
}
