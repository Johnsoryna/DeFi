/**
 * dYdX v4 client wrapper.
 * REST + WebSocket for perpetual trading on the dYdX Cosmos L1 chain.
 *
 * SECURITY: @dydxprotocol/v4-client-js was compromised in Jan 2026.
 * Only use verified clean versions. NEVER install 3.4.1, 1.22.1, 1.15.2, or 1.0.31.
 */
import { createLogger } from '../lib/logger.js'
import { withRetry } from '../lib/retry.js'
import { DYDX } from '../config/addresses.js'
import { config } from '../config/index.js'
import type { DydxMarket, DydxPosition } from '../types/protocol.js'
import type { DydxOrderParams } from '../types/trading.js'

const log = createLogger('dydx')

// ─── REST Client ────────────────────────────────────────────────────

const BASE_URL = DYDX.indexerRest

async function fetchJson<T>(path: string): Promise<T> {
  return withRetry(
    async () => {
      const res = await fetch(`${BASE_URL}${path}`)
      if (!res.ok) throw new Error(`dYdX API ${res.status}: ${path}`)
      return (await res.json()) as T
    },
    `dydx:${path}`,
    { maxRetries: 2, baseDelayMs: 1000 },
  )
}

/**
 * Get all available perpetual markets.
 */
export async function getMarkets(): Promise<Record<string, DydxMarket>> {
  const data = await fetchJson<{ markets: Record<string, any> }>('/perpetualMarkets')
  const result: Record<string, DydxMarket> = {}

  for (const [key, m] of Object.entries(data.markets)) {
    result[key] = {
      market: m.ticker,
      status: m.status,
      oraclePrice: m.oraclePrice,
      baseAsset: m.baseAsset,
      tickSize: m.tickSize,
      stepSize: m.stepSize,
      initialMarginFraction: m.initialMarginFraction,
      maintenanceMarginFraction: m.maintenanceMarginFraction,
    }
  }

  return result
}

/**
 * Get open positions for an address.
 */
export async function getPositions(
  address: string,
  subaccountNumber: number = 0,
): Promise<DydxPosition[]> {
  const data = await fetchJson<{ positions: any[] }>(
    `/perpetualPositions?address=${address}&subaccountNumber=${subaccountNumber}&status=OPEN`,
  )

  return data.positions.map((p: any) => ({
    market: p.market,
    status: p.status,
    side: p.side,
    size: p.size,
    maxSize: p.maxSize,
    entryPrice: p.entryPrice,
    exitPrice: p.exitPrice,
    unrealizedPnl: p.unrealizedPnl,
    realizedPnl: p.realizedPnl,
    netFunding: p.netFunding,
  }))
}

/**
 * Get the current oracle price for a market.
 */
export async function getOraclePrice(market: string): Promise<string> {
  const markets = await getMarkets()
  const m = markets[market]
  if (!m) throw new Error(`Unknown dYdX market: ${market}`)
  return m.oraclePrice
}

// ─── WebSocket Client ───────────────────────────────────────────────

type WsMessageHandler = (data: any) => void

let ws: WebSocket | null = null
const subscriptions = new Map<string, WsMessageHandler>()

/**
 * Connect to the dYdX WebSocket and subscribe to channels.
 */
export function connectWebSocket(handlers: {
  onSubaccountUpdate?: WsMessageHandler
  onOrderbookUpdate?: WsMessageHandler
  onMarketUpdate?: WsMessageHandler
}): void {
  if (typeof WebSocket === 'undefined') {
    log.warn('WebSocket not available in this environment — skipping dYdX WS')
    return
  }

  ws = new WebSocket(DYDX.indexerWs)

  ws.onopen = () => {
    log.info('dYdX WebSocket connected')

    if (handlers.onMarketUpdate) {
      ws!.send(JSON.stringify({ type: 'subscribe', channel: 'v4_markets' }))
      subscriptions.set('v4_markets', handlers.onMarketUpdate)
    }
  }

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data as string)
      const channel = data.channel
      const handler = subscriptions.get(channel)
      if (handler) handler(data)
    } catch (err) {
      log.error({ err }, 'dYdX WS message parse error')
    }
  }

  ws.onerror = (event) => {
    log.error('dYdX WebSocket error')
  }

  ws.onclose = () => {
    log.warn('dYdX WebSocket closed — reconnecting in 5s')
    setTimeout(() => connectWebSocket(handlers), 5000)
  }
}

/**
 * Subscribe to subaccount updates (positions, orders, fills).
 */
export function subscribeSubaccount(address: string, subaccountNumber: number = 0): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log.warn('dYdX WS not connected — cannot subscribe to subaccount')
    return
  }
  ws.send(
    JSON.stringify({
      type: 'subscribe',
      channel: 'v4_subaccounts',
      id: `${address}/${subaccountNumber}`,
    }),
  )
}

/**
 * Subscribe to orderbook for a specific market.
 */
export function subscribeOrderbook(market: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log.warn('dYdX WS not connected — cannot subscribe to orderbook')
    return
  }
  ws.send(
    JSON.stringify({
      type: 'subscribe',
      channel: 'v4_orderbook',
      id: market,
    }),
  )
}

export function disconnectWebSocket(): void {
  if (ws) {
    ws.close()
    ws = null
  }
  subscriptions.clear()
}
