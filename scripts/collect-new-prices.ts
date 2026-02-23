/**
 * Collect historical prices using DeFi Llama /chart in weekly chunks.
 * Max span ~168 hours per request to avoid 500 errors.
 */
import Database from 'better-sqlite3'
import { sleep } from '../src/lib/retry.js'

const DB_PATH = 'data/backtest.db'
const db = new Database(DB_PATH)

const TOKENS: Array<{ symbol: string; coin: string }> = [
  // Existing tokens (will skip if >8000 points)
  { symbol: 'AVAX', coin: 'avax:0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7' },
  { symbol: 'JUP', coin: 'coingecko:jupiter-exchange-solana' },
  { symbol: 'TIA', coin: 'coingecko:celestia' },
  { symbol: 'SUI', coin: 'coingecko:sui' },
  { symbol: 'SEI', coin: 'coingecko:sei-network' },
  { symbol: 'POL', coin: 'ethereum:0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6' },
  { symbol: 'STRK', coin: 'ethereum:0xCa14007Eff0dB1f8135f4C25B34De49AB0d42766' },
  // Re-enabled DeFi protocols
  { symbol: 'CVX', coin: 'coingecko:convex-finance' },
  // New Tier A tokens (dYdX v4 vol >$5K/day)
  { symbol: 'ATOM', coin: 'coingecko:cosmos' },
  { symbol: 'APT', coin: 'coingecko:aptos' },
  { symbol: 'AXL', coin: 'ethereum:0x467719aD09025FcC6cF6F8311755809d45a5E5f3' },
  { symbol: 'NEAR', coin: 'coingecko:near' },
  { symbol: 'INJ', coin: 'coingecko:injective-protocol' },
  { symbol: 'BLUR', coin: 'ethereum:0x5283D291DBCF85356A21bA090E6db59121208b44' },
  { symbol: 'JTO', coin: 'coingecko:jito-governance-token' },
  { symbol: 'ZK', coin: 'coingecko:zksync' },
  { symbol: 'DRIFT', coin: 'coingecko:drift-protocol' },
  { symbol: 'PYTH', coin: 'coingecko:pyth-network' },
  { symbol: 'STX', coin: 'coingecko:blockstack' },
  // ─── New Candidates (Feb 2026) ─────────────────────────────────────────────
  // Venus: BSC lending token, XVSUSDT on Binance Futures
  { symbol: 'XVS', coin: 'coingecko:venus' },
  // Rocket Pool: ETH staking protocol token, RPLUSDT on Binance Futures
  { symbol: 'RPL', coin: 'coingecko:rocket-pool' },
  // ─── Feb 2026 v2 ────────────────────────────────────────────────────────────
  // The Graph: GRT indexer token, GRTUSDT on Binance Futures
  { symbol: 'GRT', coin: 'coingecko:the-graph' },
  // SNX already has 13,265 points, will be skipped
  // PENDLE already has 5,995 points, check if needs extension
  { symbol: 'PENDLE', coin: 'coingecko:pendle' },
  // ─── Euler Finance (Feb 2026) ─────────────────────────────────────────────
  // EUL: Euler Finance governance token, EULUSDT on Binance Futures (~$17M daily vol)
  { symbol: 'EUL', coin: 'coingecko:euler' },
]

const FROM_TS = Math.floor(new Date('2025-02-01T00:00:00Z').getTime() / 1000)
const TO_TS = Math.floor(new Date('2026-02-15T00:00:00Z').getTime() / 1000)
const CHUNK_HOURS = 168  // 1 week per request
const CHUNK_SECS = CHUNK_HOURS * 3600

const insertStmt = db.prepare(
  `INSERT OR IGNORE INTO historical_prices (asset, timestamp, price) VALUES (?, ?, ?)`
)

async function fetchChunk(coin: string, startTs: number): Promise<Array<{ timestamp: number; price: number }>> {
  const url = `https://coins.llama.fi/chart/${coin}?start=${startTs}&span=${CHUNK_HOURS}&period=1h`
  const r = await fetch(url)
  if (r.status === 429) throw new Error('RATE_LIMIT')
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const data = await r.json() as any
  const coinData = data.coins?.[coin]
  const prices = coinData?.prices
  if (!prices || !Array.isArray(prices)) return []
  return prices as Array<{ timestamp: number; price: number }>
}

async function main() {
  for (const token of TOKENS) {
    const count = (db.prepare(`SELECT COUNT(*) as c FROM historical_prices WHERE asset = ?`).get(token.symbol) as any)?.c || 0
    console.log(`${token.symbol}: ${count} existing`)
  }

  let totalCollected = 0
  const totalWeeks = Math.ceil((TO_TS - FROM_TS) / CHUNK_SECS)

  for (const token of TOKENS) {
    const existing = (db.prepare(`SELECT COUNT(*) as c FROM historical_prices WHERE asset = ?`).get(token.symbol) as any)?.c || 0
    if (existing > 8000) {
      console.log(`\n${token.symbol}: Already has ${existing} points, skipping`)
      continue
    }

    console.log(`\n--- ${token.symbol} ---`)
    let inserted = 0
    let week = 0

    for (let chunkStart = FROM_TS; chunkStart < TO_TS; chunkStart += CHUNK_SECS) {
      week++
      let retries = 0
      let prices: Array<{ timestamp: number; price: number }> = []

      while (retries < 5) {
        try {
          prices = await fetchChunk(token.coin, chunkStart)
          break
        } catch (e: any) {
          if (e.message === 'RATE_LIMIT') {
            retries++
            const wait = 10000 * retries
            console.log(`  Rate limited, waiting ${wait / 1000}s...`)
            await sleep(wait)
          } else {
            console.error(`  Week ${week} error: ${e.message}`)
            break
          }
        }
      }

      const insertBatch = db.transaction(() => {
        for (const point of prices) {
          const msTs = point.timestamp * 1000  // Store as millisecond integer (consistent with dataCollector)
          try {
            const r = insertStmt.run(token.symbol, msTs, point.price.toString())
            if (r.changes > 0) inserted++
          } catch { /* dup */ }
        }
      })
      insertBatch()

      if (week % 10 === 0) {
        console.log(`  ${token.symbol}: week ${week}/${totalWeeks} (${inserted} new)`)
      }

      await sleep(1500) // 1.5s between requests
    }

    totalCollected += inserted
    console.log(`  ${token.symbol}: Done! ${inserted} new points`)
  }

  console.log(`\n=== FINAL ===`)
  for (const token of TOKENS) {
    const count = (db.prepare(`SELECT COUNT(*) as c FROM historical_prices WHERE asset = ?`).get(token.symbol) as any)?.c || 0
    const minD = (db.prepare(`SELECT MIN(timestamp) as m FROM historical_prices WHERE asset = ?`).get(token.symbol) as any)?.m
    const maxD = (db.prepare(`SELECT MAX(timestamp) as m FROM historical_prices WHERE asset = ?`).get(token.symbol) as any)?.m
    console.log(`  ${token.symbol}: ${count} [${minD || 'none'} → ${maxD || 'none'}]`)
  }
  console.log(`Total: ${totalCollected}`)
}

main().catch(console.error)
