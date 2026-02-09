/**
 * Price monitor.
 * Primary: dYdX WebSocket v4_markets channel for oracle prices.
 * Secondary: DefiLlama prices API for assets not on dYdX.
 */
import * as dydxClient from '../clients/dydx.js'
import * as defiLlama from '../clients/defillama.js'
import { TOKENS } from '../config/addresses.js'
import { eventBus } from '../lib/eventBus.js'
import { createLogger } from '../lib/logger.js'
import { sleep } from '../lib/retry.js'

const log = createLogger('price-monitor')

let running = false

// ─── Price Cache ────────────────────────────────────────────────────

const prices = new Map<string, { price: string; source: string; updatedAt: number }>()

/**
 * Get the latest cached price for an asset.
 */
export function getPrice(asset: string): string | null {
  return prices.get(asset.toUpperCase())?.price ?? null
}

/**
 * Get all cached prices.
 */
export function getAllPrices(): Map<string, { price: string; source: string; updatedAt: number }> {
  return new Map(prices)
}

// ─── dYdX WebSocket Price Feed ──────────────────────────────────────

function handleDydxMarketUpdate(data: any): void {
  try {
    if (data.type === 'channel_data' || data.type === 'subscribed') {
      const markets = data.contents?.markets ?? data.contents?.trading ?? {}

      for (const [market, info] of Object.entries(markets) as [string, any][]) {
        const oraclePrice = info?.oraclePrice
        if (!oraclePrice) continue

        const asset = market.replace('-USD', '').toUpperCase()
        const prev = prices.get(asset)

        prices.set(asset, {
          price: oraclePrice,
          source: 'dydx',
          updatedAt: Date.now(),
        })

        // Emit price update if changed
        if (!prev || prev.price !== oraclePrice) {
          eventBus.emit('price:update', { asset, price: oraclePrice, source: 'dydx' })
        }
      }
    }
  } catch (err) {
    log.error({ err }, 'Error processing dYdX market update')
  }
}

// ─── DefiLlama Price Feed ───────────────────────────────────────────

const TOKEN_COINS = Object.entries(TOKENS).map(([symbol, address]) => ({
  symbol: symbol.toUpperCase(),
  coin: defiLlama.buildCoinId('ethereum', address),
}))

async function fetchDefiLlamaPrices(): Promise<void> {
  try {
    const coins = TOKEN_COINS.map((t) => t.coin)
    const result = await defiLlama.getCurrentPrices(coins)

    for (const tokenConfig of TOKEN_COINS) {
      const priceData = result[tokenConfig.coin]
      if (!priceData) continue

      const asset = tokenConfig.symbol
      const prev = prices.get(asset)

      // Only update if dYdX hasn't provided a more recent price
      if (prev && prev.source === 'dydx' && Date.now() - prev.updatedAt < 30_000) {
        continue
      }

      prices.set(asset, {
        price: priceData.price.toString(),
        source: 'defillama',
        updatedAt: Date.now(),
      })

      if (!prev || prev.price !== priceData.price.toString()) {
        eventBus.emit('price:update', {
          asset,
          price: priceData.price.toString(),
          source: 'defillama',
        })
      }
    }
  } catch (err) {
    log.error({ err }, 'DefiLlama price fetch error')
  }
}

// ─── Poll Loop ──────────────────────────────────────────────────────

async function pollLoop(): Promise<void> {
  while (running) {
    await fetchDefiLlamaPrices()
    await sleep(30_000) // Refresh DefiLlama prices every 30s
  }
}

// ─── Public API ─────────────────────────────────────────────────────

export function startPriceMonitor(): void {
  running = true

  // Start dYdX WebSocket feed
  dydxClient.connectWebSocket({
    onMarketUpdate: handleDydxMarketUpdate,
  })

  // Start DefiLlama polling as secondary source
  fetchDefiLlamaPrices().catch(() => {})
  pollLoop().catch((err) => log.error({ err }, 'Price poll loop crashed'))

  log.info('Price monitor started')
}

export function stopPriceMonitor(): void {
  running = false
  dydxClient.disconnectWebSocket()
  log.info('Price monitor stopped')
}
