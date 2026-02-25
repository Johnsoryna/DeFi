/**
 * Price monitor.
 * Primary: Binance Futures WebSocket markPrice stream for all symbols.
 * Secondary: DefiLlama prices API for assets not on Binance.
 */
import * as binanceClient from '../clients/binance.js'
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

// ─── Binance WebSocket Price Feed ───────────────────────────────────

interface BinanceMarkPriceEntry {
  s: string   // Symbol (e.g. 'AAVEUSDT')
  p: string   // Mark price
  e?: string  // Event type
}

function handleBinanceMarkPriceUpdate(data: unknown): void {
  try {
    const entries = Array.isArray(data) ? data as BinanceMarkPriceEntry[] : [data as BinanceMarkPriceEntry]

    for (const entry of entries) {
      const symbol = entry.s
      const markPrice = entry.p
      if (!symbol || !markPrice) continue

      // Strip 'USDT' suffix to get base asset symbol
      if (!symbol.endsWith('USDT')) continue
      const asset = symbol.slice(0, -4).toUpperCase()

      const prev = prices.get(asset)

      prices.set(asset, {
        price: markPrice,
        source: 'binance',
        updatedAt: Date.now(),
      })

      if (!prev || prev.price !== markPrice) {
        eventBus.emit('price:update', { asset, price: markPrice, source: 'binance' })
      }
    }
  } catch (err) {
    log.error({ err }, 'Error processing Binance mark price update')
  }
}

// ─── DefiLlama Price Feed ───────────────────────────────────────────

// L2 governance tokens need their native chain for DeFi Llama lookups
const L2_TOKEN_CHAINS: Record<string, string> = {
  ARB: 'arbitrum',
  OP: 'optimism',
}

const TOKEN_COINS = Object.entries(TOKENS).map(([symbol, address]) => ({
  symbol: symbol.toUpperCase(),
  coin: defiLlama.buildCoinId(L2_TOKEN_CHAINS[symbol.toUpperCase()] ?? 'ethereum', address),
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

      // Only update if Binance hasn't provided a more recent price
      if (prev && prev.source === 'binance' && Date.now() - prev.updatedAt < 30_000) {
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
    await sleep(30_000)
  }
}

// ─── Public API ─────────────────────────────────────────────────────

export function startPriceMonitor(): void {
  running = true

  // Start Binance Futures WebSocket feed (mark prices for all symbols)
  binanceClient.connectWebSocket({
    onMarkPriceUpdate: handleBinanceMarkPriceUpdate,
  })

  // Start DefiLlama polling as secondary source
  fetchDefiLlamaPrices().catch((err) => log.error({ err }, 'Initial DefiLlama price fetch failed'))
  pollLoop().catch((err) => log.error({ err }, 'Price poll loop crashed'))

  log.info('Price monitor started')
}

export function stopPriceMonitor(): void {
  running = false
  binanceClient.disconnectWebSocket()
  log.info('Price monitor stopped')
}
