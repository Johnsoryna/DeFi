/**
 * Binance Futures (USDT-M) client wrapper.
 * REST + WebSocket for perpetual trading on Binance.
 *
 * Auth: HMAC-SHA256 signatures on query string.
 * No external npm package needed — raw fetch + native crypto.
 */
import { createHmac } from 'crypto'
import { createLogger } from '../lib/logger.js'
import { withRetry } from '../lib/retry.js'
import { BINANCE } from '../config/addresses.js'
import { config } from '../config/index.js'
import { sendAlert } from '../execution/alertService.js'
import type { BinanceMarket, BinancePosition } from '../types/protocol.js'

const log = createLogger('binance')

// ─── REST Client ────────────────────────────────────────────────────

const BASE_URL = config.binanceTestnet ? BINANCE.testnetRest : BINANCE.futuresRest

function sign(queryString: string): string {
  if (!config.binanceApiSecret) throw new Error('BINANCE_API_SECRET not configured')
  return createHmac('sha256', config.binanceApiSecret).update(queryString).digest('hex')
}

function authHeaders(): Record<string, string> {
  if (!config.binanceApiKey) throw new Error('BINANCE_API_KEY not configured')
  return { 'X-MBX-APIKEY': config.binanceApiKey }
}

/** Fetch public endpoint (no auth) */
async function fetchPublic<T>(path: string): Promise<T> {
  return withRetry(
    async () => {
      const res = await fetch(`${BASE_URL}${path}`)
      if (!res.ok) throw new Error(`Binance API ${res.status}: ${path} — ${await res.text()}`)
      return (await res.json()) as T
    },
    `binance:${path}`,
    { maxRetries: 2, baseDelayMs: 1000 },
  )
}

/**
 * Fetch USER_STREAM endpoint (API key header only, no HMAC signature).
 * Binance USER_STREAM security type requires X-MBX-APIKEY but NOT a signature.
 */
async function fetchUserStream<T>(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: authHeaders(),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Binance API ${res.status}: ${method} ${path} — ${body}`)
  }
  return (await res.json()) as T
}

/** Fetch signed endpoint (requires API key + HMAC signature) */
async function fetchSigned<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  params: Record<string, string | number | boolean> = {},
): Promise<T> {
  return withRetry(
    async () => {
      const qs = new URLSearchParams()
      qs.set('timestamp', Date.now().toString())
      qs.set('recvWindow', '5000')
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') qs.set(k, String(v))
      }
      const queryString = qs.toString()
      const signature = sign(queryString)
      const url = `${BASE_URL}${path}?${queryString}&signature=${signature}`

      const res = await fetch(url, {
        method,
        headers: authHeaders(),
      })
      if (!res.ok) {
        const body = await res.text()
        throw new Error(`Binance API ${res.status}: ${method} ${path} — ${body}`)
      }
      return (await res.json()) as T
    },
    `binance:${path}`,
    { maxRetries: 2, baseDelayMs: 1000 },
  )
}

// ─── Position Mode ──────────────────────────────────────────────────

/**
 * Ensure the account is in One-Way position mode.
 * Hedge Mode requires positionSide on every order; the bot uses One-Way mode.
 * Call once at startup before any trading activity.
 */
export async function ensureOneWayMode(): Promise<void> {
  try {
    // GET current mode first — only POST if change is actually needed.
    // Sending an unnecessary POST /fapi/v1/positionSide/dual can return -4067
    // ("cannot change if open orders exist") and may cause Binance to cancel
    // conditional algo orders as a side effect of the failed mode-change attempt.
    const currentMode = await fetchSigned<{ dualSidePosition: boolean }>(
      'GET', '/fapi/v1/positionSide/dual',
    )
    if (!currentMode.dualSidePosition) {
      log.debug('Position mode already One-Way — no change needed')
      return
    }

    // Account is in Hedge Mode — attempt to switch. Requires no open orders.
    const qs = new URLSearchParams()
    qs.set('timestamp', Date.now().toString())
    qs.set('recvWindow', '5000')
    qs.set('dualSidePosition', 'false')
    const queryString = qs.toString()
    const signature = sign(queryString)
    const url = `${BASE_URL}/fapi/v1/positionSide/dual?${queryString}&signature=${signature}`

    const res = await fetch(url, { method: 'POST', headers: authHeaders() })
    const body = await res.text()

    if (res.ok) {
      log.info('Position mode set to One-Way')
    } else {
      log.warn({ status: res.status, body }, 'Failed to switch from Hedge Mode to One-Way — cancel open orders first')
    }
  } catch (err) {
    log.warn({ err }, 'Failed to check/set position mode')
  }
}

// ─── Exchange Info (market specs) ───────────────────────────────────

interface RawSymbolInfo {
  symbol: string
  status: string
  baseAsset: string
  quoteAsset: string
  filters: Array<{
    filterType: string
    tickSize?: string
    stepSize?: string
    notional?: string
  }>
}

let exchangeInfoCache: Map<string, BinanceMarket> | null = null
let exchangeInfoTs = 0
const EXCHANGE_INFO_TTL = 3600_000 // 1 hour

/**
 * Get exchange info for all USDT-M perpetual symbols.
 * Cached for 1 hour (market specs rarely change).
 */
export async function getExchangeInfo(): Promise<Map<string, BinanceMarket>> {
  if (exchangeInfoCache && Date.now() - exchangeInfoTs < EXCHANGE_INFO_TTL) {
    return exchangeInfoCache
  }

  const data = await fetchPublic<{ symbols: RawSymbolInfo[] }>('/fapi/v1/exchangeInfo')
  const result = new Map<string, BinanceMarket>()

  for (const s of data.symbols) {
    if (s.quoteAsset !== 'USDT') continue

    const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER')
    const lotFilter = s.filters.find(f => f.filterType === 'LOT_SIZE')
    const notionalFilter = s.filters.find(f => f.filterType === 'MIN_NOTIONAL')

    result.set(s.symbol, {
      symbol: s.symbol,
      status: s.status,
      markPrice: '0',
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
      tickSize: priceFilter?.tickSize ?? '0.01',
      stepSize: lotFilter?.stepSize ?? '0.001',
      minNotional: notionalFilter?.notional ?? '5',
      maxLeverage: 20, // Will be updated per-symbol if needed
    })
  }

  exchangeInfoCache = result
  exchangeInfoTs = Date.now()
  log.info({ symbols: result.size }, 'Exchange info loaded')
  return result
}

/**
 * Get mark price for a symbol.
 */
export async function getMarkPrice(symbol: string): Promise<string> {
  const data = await fetchPublic<{ markPrice: string }>(`/fapi/v1/premiumIndex?symbol=${symbol}`)
  return data.markPrice
}

/**
 * Get the current funding rate for a symbol.
 * Returns lastFundingRate as a float (e.g. 0.0001 = 0.010%/8h).
 * Positive = longs pay shorts (favourable for short trades).
 */
export async function getFundingRate(symbol: string): Promise<number> {
  const data = await fetchPublic<{ lastFundingRate: string }>(`/fapi/v1/premiumIndex?symbol=${symbol}`)
  return parseFloat(data.lastFundingRate)
}

/**
 * Get all mark prices.
 */
export async function getAllMarkPrices(): Promise<Array<{ symbol: string; markPrice: string }>> {
  return fetchPublic('/fapi/v1/premiumIndex')
}

/**
 * Get OHLCV klines (candlestick data) for a futures symbol.
 * Returns array of [openTime, open, high, low, close, volume, closeTime, ...].
 */
export async function getKlines(
  symbol: string,
  interval: string,
  limit: number,
): Promise<Array<[number, string, string, string, string, ...unknown[]]>> {
  return fetchPublic(`/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`)
}

// ─── Account & Positions ────────────────────────────────────────────

export interface BinanceAccountInfo {
  totalWalletBalance: string
  totalUnrealizedProfit: string
  totalMarginBalance: string
  availableBalance: string
  totalPositionInitialMargin: string
  positions: BinancePosition[]
}

/**
 * Get full account info including equity and positions.
 */
export async function getAccountInfo(): Promise<BinanceAccountInfo> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await fetchSigned<Record<string, any>>('GET', '/fapi/v2/account')
  return {
    totalWalletBalance: data.totalWalletBalance,
    totalUnrealizedProfit: data.totalUnrealizedProfit,
    totalMarginBalance: data.totalMarginBalance,
    availableBalance: data.availableBalance,
    totalPositionInitialMargin: data.totalPositionInitialMargin ?? '0',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    positions: (data.positions as any[])
      .filter((p: { positionAmt: string }) => parseFloat(p.positionAmt) !== 0)
      .map((p: Record<string, string>) => ({
        symbol: p.symbol,
        positionSide: p.positionSide,
        positionAmt: p.positionAmt,
        entryPrice: p.entryPrice,
        markPrice: p.markPrice,
        unrealizedProfit: p.unrealizedProfit ?? p.unRealizedProfit,
        leverage: p.leverage,
        marginType: p.marginType,
        liquidationPrice: p.liquidationPrice,
      })),
  }
}

/**
 * Get open positions only.
 * Uses /fapi/v2/positionRisk (NOT /fapi/v2/account) — the account endpoint returns
 * wrong positionAmt for some symbols (e.g. DYDX: -0.1 instead of -1200.8) and
 * does not include markPrice. positionRisk is the authoritative position source.
 */
export async function getPositions(): Promise<BinancePosition[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await fetchSigned<any[]>('GET', '/fapi/v2/positionRisk', {})
  return data
    .filter((p: { positionAmt: string }) => parseFloat(p.positionAmt) !== 0)
    .map((p: Record<string, string>) => ({
      symbol: p.symbol,
      positionSide: p.positionSide,
      positionAmt: p.positionAmt,
      entryPrice: p.entryPrice,
      markPrice: p.markPrice,
      unrealizedProfit: p.unRealizedProfit ?? p.unrealizedProfit,
      leverage: p.leverage,
      marginType: p.marginType,
      liquidationPrice: p.liquidationPrice,
    }))
}

// ─── Trading ────────────────────────────────────────────────────────

/**
 * Set leverage for a symbol. Must be called BEFORE placing leveraged orders.
 */
export async function setLeverage(symbol: string, leverage: number): Promise<void> {
  await fetchSigned('POST', '/fapi/v1/leverage', {
    symbol,
    leverage: Math.round(leverage),
  })
  log.debug({ symbol, leverage }, 'Leverage set')
}

/**
 * Set margin type for a symbol (CROSSED or ISOLATED).
 */
export async function setMarginType(symbol: string, marginType: 'CROSSED' | 'ISOLATED'): Promise<void> {
  await withRetry(
    async () => {
      const qs = new URLSearchParams()
      qs.set('timestamp', Date.now().toString())
      qs.set('recvWindow', '5000')
      qs.set('symbol', symbol)
      qs.set('marginType', marginType)
      const queryString = qs.toString()
      const url = `${BASE_URL}/fapi/v1/marginType?${queryString}&signature=${sign(queryString)}`
      const res = await fetch(url, { method: 'POST', headers: authHeaders() })
      if (!res.ok) {
        const body = await res.text()
        // -4046 = "No need to change margin type" — already set correctly, treat as success
        if (body.includes('-4046')) {
          log.debug({ symbol, marginType }, 'Margin type already set — skipping')
          return
        }
        throw new Error(`Binance API ${res.status}: POST /fapi/v1/marginType — ${body}`)
      }
      log.debug({ symbol, marginType }, 'Margin type set')
    },
    `binance:/fapi/v1/marginType`,
    { maxRetries: 2, baseDelayMs: 1000 },
  )
}

/**
 * Place a new order — idempotent via newClientOrderId.
 *
 * withRetry inside fetchSigned can retry on network timeout after Binance already processed
 * the order. To prevent a double entry, we generate a newClientOrderId before the retry loop.
 * If Binance rejects with -2010 (duplicate clientOrderId), we fetch the original order instead.
 */
export async function placeOrder(params: Record<string, string | number | boolean>): Promise<{
  orderId: number
  symbol: string
  status: string
  avgPrice: string
  executedQty: string
}> {
  const clientOrderId = `bot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const paramsWithId = { newClientOrderId: clientOrderId, ...params }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await fetchSigned<any>('POST', '/fapi/v1/order', paramsWithId)
  } catch (err) {
    // -2010: duplicate clientOrderId — the order was already placed on a previous attempt.
    // Recover by fetching the existing order rather than propagating the error.
    if (err instanceof Error && err.message.includes('-2010')) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return fetchSigned<any>('GET', '/fapi/v1/order', {
        symbol: params.symbol as string,
        origClientOrderId: clientOrderId,
      })
    }
    throw err
  }
}

/**
 * Place a conditional (stop-market / take-profit-market) order via Algo API.
 * STOP_MARKET and TAKE_PROFIT_MARKET must go through POST /fapi/v1/algoOrder
 * with algoType=CONDITIONAL — /fapi/v1/order rejects them with -4120 on this account.
 * triggerPrice is the activation price; workingType should be MARK_PRICE.
 */
export async function placeConditionalAlgo(params: {
  symbol: string
  side: 'BUY' | 'SELL'
  quantity: string
  type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET'
  triggerPrice: string
  reduceOnly?: boolean
  workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE'
}): Promise<{ algoId: number; symbol: string; status: string }> {
  // clientAlgoId provides idempotency: if withRetry fires twice after a network timeout,
  // Binance rejects the duplicate. Since orders are reduceOnly, no extra exposure is created.
  const clientAlgoId = `bot-cond-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const body: Record<string, string | number | boolean> = {
    clientAlgoId,
    symbol: params.symbol,
    side: params.side,
    algoType: 'CONDITIONAL',
    type: params.type,
    quantity: params.quantity,
    triggerPrice: params.triggerPrice,
  }
  if (params.reduceOnly) body.reduceOnly = 'true'
  if (params.workingType) body.workingType = params.workingType
  try {
    return await fetchSigned<{ algoId: number; symbol: string; status: string }>('POST', '/fapi/v1/algoOrder', body)
  } catch (err) {
    // Duplicate clientAlgoId: order was already placed on a prior attempt (network timeout + retry).
    // -2082 is the Binance algo-order duplicate code; -2010 is the generic duplicate code.
    // The order IS on Binance and is reduceOnly — treat as success to avoid false CRITICAL alerts.
    if (err instanceof Error && (err.message.includes('-2082') || err.message.includes('-2010') || err.message.includes('clientAlgoId'))) {
      log.warn({ symbol: params.symbol, clientAlgoId, type: params.type }, 'Algo order duplicate — order already exists, treating as success')
      return { algoId: -1, symbol: params.symbol, status: 'EXISTING' }
    }
    throw err
  }
}

/**
 * Cancel all open conditional/algo orders for a symbol.
 * Queries GET /fapi/v1/openAlgoOrders and cancels each matching the symbol.
 * Must be called alongside cancelAllOpenOrders() for complete order cleanup.
 */
export async function cancelAlgoOrdersForSymbol(symbol: string): Promise<void> {
  try {
    // Binance returns a direct array (not {orders:[]}) when no symbol filter is used.
    // Do NOT pass symbol filter — Binance ignores it and may return an empty object.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await fetchSigned<any>('GET', '/fapi/v1/openAlgoOrders', {})
    const allOrders: Array<{ algoId: number; symbol: string }> = Array.isArray(data)
      ? data
      : (data.orders ?? [])
    const toCancel = allOrders.filter((o) => o.symbol === symbol)
    await Promise.all(
      toCancel.map((o) =>
        fetchSigned('DELETE', '/fapi/v1/algoOrder', { algoId: o.algoId }).catch((err) =>
          log.debug({ err, algoId: o.algoId }, 'Failed to cancel single algo order'),
        ),
      ),
    )
    if (toCancel.length > 0) {
      log.debug({ symbol, cancelled: toCancel.length }, 'Conditional algo orders cancelled')
    }
  } catch (err) {
    log.warn({ err, symbol }, 'Failed to list/cancel algo open orders')
  }
}

/**
 * Place a trailing stop market order via the Algo API.
 * Works with: /fapi/v1/algoOrder + algoType=CONDITIONAL + type=TRAILING_STOP_MARKET + callbackRate
 * Confirmed working 2026-03-02 via live API probe (algoId=2000000548663520).
 *
 * For a SHORT position (BUY side):
 *   - callbackRate: trailing distance as percentage (e.g. 5 = 5%)
 *   - Trail starts immediately from current price — Binance rejects triggerPrice < current
 *     for BUY TRAILING_STOP_MARKET with -2007 "Invalid callBack rate" (confirmed 2026-03-02).
 *   - activationPrice param kept for API compatibility but intentionally NOT sent to Binance.
 *   - The static SL protects against immediate adverse moves until trail locks in profit.
 */
export async function placeTrailingStopAlgo(params: {
  symbol: string
  side: 'BUY' | 'SELL'
  quantity: string
  callbackRate: number
  activationPrice?: string
  reduceOnly?: boolean
}): Promise<{ algoId: number; symbol: string; status: string }> {
  const body: Record<string, string | number | boolean> = {
    symbol: params.symbol,
    side: params.side,
    algoType: 'CONDITIONAL',
    type: 'TRAILING_STOP_MARKET',
    quantity: params.quantity,
    callbackRate: String(params.callbackRate),
  }
  // NOTE: triggerPrice (activationPrice) intentionally omitted — Binance returns -2007 when
  // triggerPrice < current mark price for BUY TRAILING_STOP_MARKET on CONDITIONAL algoOrder.
  // Without triggerPrice, trail activates immediately from current price (acceptable behaviour:
  // SL provides hard backstop; trail locks in profit as position moves in our favour).
  body.workingType = 'MARK_PRICE'  // Default CONTRACT_PRICE uses last trade price — MARK_PRICE is more stable
  if (params.reduceOnly) body.reduceOnly = 'true'
  // clientAlgoId for idempotency — see placeConditionalAlgo comment
  const clientAlgoId = `bot-trail-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  body.clientAlgoId = clientAlgoId
  try {
    return await fetchSigned<{ algoId: number; symbol: string; status: string }>('POST', '/fapi/v1/algoOrder', body)
  } catch (err) {
    // Duplicate clientAlgoId — same recovery as placeConditionalAlgo
    if (err instanceof Error && (err.message.includes('-2082') || err.message.includes('-2010') || err.message.includes('clientAlgoId'))) {
      log.warn({ symbol: params.symbol, clientAlgoId }, 'Trailing stop duplicate — order already exists, treating as success')
      return { algoId: -1, symbol: params.symbol, status: 'EXISTING' }
    }
    throw err
  }
}

// ─── Income History ──────────────────────────────────────────────────

export interface IncomeRecord {
  symbol: string
  incomeType: string
  income: string
  asset: string
  time: number
  tranId: string
  tradeId: string
}

/**
 * Fetch realized income for a symbol (REALIZED_PNL, FUNDING_FEE, COMMISSION).
 * Used to compute actual trade PnL at close time, since open-position snapshots
 * always show realizedPnl=0 on Binance.
 */
export async function getIncome(params: {
  symbol: string
  startTime: number
  endTime?: number
  limit?: number
}): Promise<IncomeRecord[]> {
  const p: Record<string, string | number> = {
    symbol: params.symbol,
    startTime: params.startTime,
    limit: params.limit ?? 1000,
  }
  if (params.endTime) p.endTime = params.endTime
  return fetchSigned<IncomeRecord[]>('GET', '/fapi/v1/income', p)
}

export interface OrderRecord {
  orderId: number
  symbol: string
  status: string
  type: string
  side: string
  origQty: string
  executedQty: string
  reduceOnly: boolean
  time: number
}

/**
 * Get recent order history for a symbol.
 * Used to recover position entry timestamps after bot restart.
 */
export async function getOrderHistory(symbol: string, limit = 50): Promise<OrderRecord[]> {
  return fetchSigned<OrderRecord[]>('GET', '/fapi/v1/allOrders', { symbol, limit })
}

/**
 * Cancel an order.
 */
export async function cancelOrder(symbol: string, orderId: number): Promise<void> {
  await fetchSigned('DELETE', '/fapi/v1/order', { symbol, orderId })
}

/**
 * Cancel all open orders for a symbol (e.g. after position closes).
 * Safe to call even if no orders exist.
 */
export async function cancelAllOpenOrders(symbol: string): Promise<void> {
  try {
    await fetchSigned('DELETE', '/fapi/v1/allOpenOrders', { symbol })
    log.debug({ symbol }, 'All open orders cancelled')
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    // -2011: Unknown order — no orders to cancel, that's fine
    if (!msg.includes('-2011')) {
      log.warn({ err, symbol }, 'Failed to cancel open orders')
    }
  }
}

// ─── User Data Stream (Listen Key) ─────────────────────────────────

let listenKey: string | null = null
let listenKeyTimer: ReturnType<typeof setInterval> | null = null

/**
 * Create a listen key for the user data stream.
 * Must be kept alive every 30 minutes via PUT.
 */
export async function createListenKey(): Promise<string> {
  // USER_STREAM security type: API key header only, no HMAC signature
  const data = await fetchUserStream<{ listenKey: string }>('POST', '/fapi/v1/listenKey')
  listenKey = data.listenKey

  // Auto-keepalive every 25 minutes
  if (listenKeyTimer) clearInterval(listenKeyTimer)
  listenKeyTimer = setInterval(async () => {
    try {
      await fetchUserStream('PUT', '/fapi/v1/listenKey')
      log.debug('Listen key keepalive sent')
    } catch (err) {
      log.warn({ err }, 'Listen key keepalive failed')
    }
  }, 25 * 60_000)

  return listenKey
}

// ─── WebSocket Client ───────────────────────────────────────────────

type WsMessageHandler = (data: unknown) => void

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
const MAX_RECONNECT_DELAY_MS = 60_000
const MAX_RECONNECT_ATTEMPTS = 20

export interface BinanceWsHandlers {
  onMarkPriceUpdate?: WsMessageHandler
  onAccountUpdate?: WsMessageHandler
  onOrderUpdate?: WsMessageHandler
}

/**
 * Connect to Binance Futures WebSocket.
 * Subscribes to:
 *   - !markPrice@arr@1s (all symbol mark prices, 1s interval)
 *   - User Data Stream (account/order updates, if listenKey available)
 */
export function connectWebSocket(handlers: BinanceWsHandlers): void {
  if (typeof globalThis.WebSocket === 'undefined') {
    log.warn('WebSocket not available — skipping Binance WS')
    return
  }

  if (ws && ws.readyState !== WebSocket.CLOSED) {
    log.debug('Closing existing Binance WebSocket before reconnecting')
    ws.close()
    ws = null
  }

  // Build combined stream URL
  const streams = ['!markPrice@arr@1s']
  if (listenKey) streams.push(listenKey)
  const wsBase = config.binanceTestnet ? BINANCE.testnetWs : BINANCE.futuresWs
  const wsUrl = `${wsBase}/stream?streams=${streams.join('/')}`

  try {
    ws = new WebSocket(wsUrl)
  } catch (err) {
    log.error({ err }, 'Failed to create Binance WebSocket')
    scheduleReconnect(handlers)
    return
  }

  ws.onopen = () => {
    reconnectAttempts = 0
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    log.info('Binance WebSocket connected')
  }

  ws.onmessage = (event) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wrapper = JSON.parse(event.data as string) as { stream?: string; data?: any }
      const data = wrapper.data ?? wrapper

      // Mark price array stream
      if (wrapper.stream === '!markPrice@arr@1s' && handlers.onMarkPriceUpdate) {
        handlers.onMarkPriceUpdate(data)
        return
      }

      // User data stream events
      if (data.e === 'ACCOUNT_UPDATE' && handlers.onAccountUpdate) {
        handlers.onAccountUpdate(data)
      } else if (data.e === 'ORDER_TRADE_UPDATE' && handlers.onOrderUpdate) {
        handlers.onOrderUpdate(data)
      }
    } catch (err) {
      log.error({ err }, 'Binance WS message parse error')
    }
  }

  ws.onerror = () => {
    log.warn('Binance WebSocket error')
  }

  ws.onclose = () => {
    log.warn('Binance WebSocket closed')
    scheduleReconnect(handlers)
  }
}

function scheduleReconnect(handlers: BinanceWsHandlers): void {
  reconnectAttempts++

  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    log.warn(
      { attempts: reconnectAttempts },
      'Binance WS max fast-reconnect attempts reached — entering slow-reconnect mode (every 5 min)',
    )
    sendAlert(
      'system_error',
      'critical',
      'Binance WebSocket Degraded',
      `Fast reconnect exhausted after ${MAX_RECONNECT_ATTEMPTS} attempts. Slow-reconnect every 5 min.`,
    ).catch((err) => log.error({ err }, 'Failed to send Binance WS degraded alert'))
    // Reset counter so the next successful connection resets to fast reconnect.
    reconnectAttempts = MAX_RECONNECT_ATTEMPTS - 1
    reconnectTimer = setTimeout(() => connectWebSocket(handlers), 5 * 60_000)
    return
  }

  const delay = Math.min(5000 * 2 ** (reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS)
  log.info({ delayMs: delay, attempt: reconnectAttempts }, 'Binance WS reconnecting...')
  reconnectTimer = setTimeout(() => connectWebSocket(handlers), delay)
}

export function disconnectWebSocket(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (listenKeyTimer) {
    clearInterval(listenKeyTimer)
    listenKeyTimer = null
  }
  if (ws) {
    ws.close()
    ws = null
  }
  listenKey = null
}

// ─── Utility: Round to step/tick size ───────────────────────────────

/**
 * Round a quantity to the exchange's step size.
 * mode='floor' (default): round down — safe for entry orders (never over-buy)
 * mode='round': round to nearest — for reduce/close orders to avoid leaving tiny fragments
 */
export function roundStep(value: number, stepSize: string, mode: 'floor' | 'round' = 'floor'): string {
  const step = parseFloat(stepSize)
  if (step <= 0) return value.toFixed(8)
  const precision = Math.max(0, Math.ceil(-Math.log10(step)))
  const rounded = mode === 'round'
    ? Math.round(value / step) * step
    : Math.floor(value / step) * step
  return rounded.toFixed(precision)
}

/**
 * Round a price to the exchange's tick size.
 */
export function roundTick(value: number, tickSize: string): string {
  const tick = parseFloat(tickSize)
  if (tick <= 0) return value.toFixed(8)
  const precision = Math.max(0, Math.ceil(-Math.log10(tick)))
  const rounded = Math.round(value / tick) * tick
  return rounded.toFixed(precision)
}
