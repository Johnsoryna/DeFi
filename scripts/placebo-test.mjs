/**
 * Placebo Test — Validate governance signal alpha vs random timing
 *
 * Takes the 36 actual backtest trades and replaces their entry dates
 * with random timestamps from the same 13-month window.
 * If governance events have real predictive power, random-timed trades
 * should produce significantly worse results (~0 P&L or negative).
 *
 * If random-timed trades also profit → market regime (not events) explains returns.
 */

import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import { readFileSync } from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH   = path.join(__dirname, '../data/backtest.db')
const TRADES    = JSON.parse(readFileSync(path.join(__dirname, '../data/backtest-trades.json'), 'utf8'))

const INITIAL_PORTFOLIO = 100_000
const TICK_MS           = 3_600_000           // 1-hour ticks (matches backtest)
const WINDOW_START      = new Date('2025-01-01').getTime()
const WINDOW_END        = new Date('2026-02-20').getTime()
const ITERATIONS        = 1_000

// Fee model — mirrors resultCollector.ts
const TAKER_FEE      = 0.0005
const BASE_SLIPPAGE  = 0.0003
const LIQ_MULT = {
  AAVE: 1.5, ARB: 2.5, DYDX: 2.5, LDO: 2.0, CRV: 1.5,
  COMP: 1.5, WSTETH: 2.0, GMX: 2.0, INJ: 1.2, EIGEN: 2.0,
}

function fee(asset) {
  return BASE_SLIPPAGE * (LIQ_MULT[asset.toUpperCase()] ?? 2.0) + TAKER_FEE
}

function getPrice(db, asset, ts) {
  const row = db.prepare(
    `SELECT price FROM historical_prices WHERE asset = ? AND timestamp <= ?
     ORDER BY timestamp DESC LIMIT 1`
  ).get(asset.toUpperCase(), ts)
  return row ? parseFloat(row.price) : null
}

/**
 * Simulate a single trade from the given entry timestamp.
 * Mirrors the exact exit logic in resultCollector.ts checkExits().
 */
function simulate(db, trade, entryTs) {
  const { asset, direction, leverage, sizePct,
          stopLossPct, takeProfitPct,
          trailingStopActivation, trailingStopDistance,
          maxHoldingHours } = trade.signal

  const sym           = asset.toUpperCase()
  const maxHoldingMs  = maxHoldingHours * 3_600_000
  const margin        = INITIAL_PORTFOLIO * (sizePct / 100)
  const notional      = margin * leverage
  const maxLoss       = INITIAL_PORTFOLIO * 0.10   // $10K cap

  const rawEntry = getPrice(db, sym, entryTs)
  if (!rawEntry) return null

  // Apply entry slippage
  const entryPrice = direction === 'short'
    ? rawEntry * (1 - fee(sym))
    : rawEntry * (1 + fee(sym))

  let peakPnlPct      = 0
  let trailingActive  = false

  for (let dt = TICK_MS; dt <= maxHoldingMs; dt += TICK_MS) {
    const price = getPrice(db, sym, entryTs + dt)
    if (!price) continue

    const changePct = direction === 'short'
      ? (entryPrice - price) / entryPrice
      : (price - entryPrice) / entryPrice

    if (changePct > peakPnlPct) peakPnlPct = changePct

    const pnl          = changePct * notional
    const holdingHours = dt / 3_600_000

    // 0. Max-loss-cap ($10K)
    if (pnl < -maxLoss) {
      return { pnl: pnl - notional * fee(sym), reason: 'max-loss-cap' }
    }

    // 1. Stop-loss with 72h min-hold + time-decay from 14d
    let effSL = stopLossPct
    if (changePct < 0 && holdingHours > 336) {
      const decay = Math.min(3, (holdingHours - 336) / 168)
      effSL = stopLossPct * Math.max(0.65, 1.0 - decay * 0.117)
    }
    if (holdingHours >= 72 && changePct < -effSL) {
      return { pnl: pnl - notional * fee(sym), reason: 'stop-loss' }
    }

    // 2. Near-liquidation
    if (pnl <= -margin * 0.90) {
      return { pnl: pnl - notional * fee(sym), reason: 'liquidation' }
    }

    // 3. Take-profit
    if (changePct >= takeProfitPct) {
      return { pnl: pnl - notional * fee(sym), reason: 'take-profit' }
    }

    // 4. Trailing stop (Binance 5% cap)
    const capTrail = Math.min(trailingStopDistance, 0.05)
    if (!trailingActive && changePct >= trailingStopActivation) trailingActive = true
    if (trailingActive) {
      const effTrail = peakPnlPct >= trailingStopActivation * 2 ? capTrail * 0.75 : capTrail
      if (peakPnlPct - changePct >= effTrail) {
        return { pnl: pnl - notional * fee(sym), reason: 'trailing-stop' }
      }
    }
  }

  // 5. Max-holding-time exit
  const finalPrice = getPrice(db, sym, entryTs + maxHoldingMs)
  if (!finalPrice) return null
  const finalChange = direction === 'short'
    ? (entryPrice - finalPrice) / entryPrice
    : (finalPrice - entryPrice) / entryPrice
  return { pnl: finalChange * notional - notional * fee(sym), reason: 'max-holding' }
}

function runIteration(db) {
  let totalPnl = 0, wins = 0, losses = 0
  for (const trade of TRADES) {
    const maxHoldMs = trade.signal.maxHoldingHours * 3_600_000
    // Random entry anywhere in the window such that the full hold fits
    const randTs = WINDOW_START + Math.random() * (WINDOW_END - WINDOW_START - maxHoldMs)
    const result = simulate(db, trade, Math.round(randTs))
    if (result) {
      totalPnl += result.pnl
      result.pnl > 0 ? wins++ : losses++
    }
  }
  return { totalPnl, wins, losses }
}

// ─── Main ────────────────────────────────────────────────────────────

const db = new Database(DB_PATH, { readonly: true })

// Actual backtest P&L (from trade records)
const actualPnl = TRADES.reduce((s, t) => s + (t.pnl ?? 0), 0)

console.log(`Placebo test: ${ITERATIONS} iterations × ${TRADES.length} trade templates`)
console.log(`(Same assets + directions, random entry dates within Jan 2025–Feb 2026)\n`)

const results = []
for (let i = 0; i < ITERATIONS; i++) {
  results.push(runIteration(db))
  if ((i + 1) % 200 === 0) process.stdout.write(`  ${i + 1}/${ITERATIONS} done\n`)
}

db.close()

const pnls   = results.map(r => r.totalPnl).sort((a, b) => a - b)
const avg    = pnls.reduce((a, b) => a + b, 0) / ITERATIONS
const median = pnls[Math.floor(ITERATIONS / 2)]
const p5     = pnls[Math.floor(ITERATIONS * 0.05)]
const p95    = pnls[Math.floor(ITERATIONS * 0.95)]
const pos    = pnls.filter(p => p > 0).length
const beatActual = pnls.filter(p => p > actualPnl).length

console.log('\n══════════════════════════════════════════════════════')
console.log('  PLACEBO TEST — Random Timing vs Governance Events')
console.log('══════════════════════════════════════════════════════')
console.log(`Actual backtest P&L (governance events):  $${actualPnl.toFixed(0).padStart(9)}`)
console.log(`Random timing — average P&L:              $${avg.toFixed(0).padStart(9)}`)
console.log(`Random timing — median P&L:               $${median.toFixed(0).padStart(9)}`)
console.log(`Random timing — 5th / 95th percentile:    $${p5.toFixed(0)} / $${p95.toFixed(0)}`)
console.log(`Positive random runs:  ${pos}/${ITERATIONS} (${(pos / ITERATIONS * 100).toFixed(1)}%)`)
console.log(`Runs beating actual:   ${beatActual}/${ITERATIONS} (${(beatActual / ITERATIONS * 100).toFixed(1)}%)`)
console.log('──────────────────────────────────────────────────────')
const ratio = avg !== 0 ? (actualPnl / avg).toFixed(1) : '∞'
console.log(`Governance edge ratio: ${ratio}× (actual ÷ random-avg)`)
console.log('══════════════════════════════════════════════════════')

if (avg > 0 && avg > actualPnl * 0.5) {
  console.log('\n⚠  Random timing also profitable → MARKET REGIME explains most returns')
  console.log('   Governance events are a selection mask on an already-bullish short market')
} else if (avg < 0 && actualPnl > 50_000) {
  console.log('\n✓  Random timing LOSES money → Governance events add REAL directional alpha')
  console.log('   The entry timing from NLP analysis is the primary profit driver')
} else if (avg > 0 && avg < actualPnl * 0.3) {
  console.log('\n~  Partial alpha: random timing weakly positive, governance events significantly better')
  console.log('   Market bias helps, but governance event timing adds material edge')
}
