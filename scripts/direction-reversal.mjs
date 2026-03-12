/**
 * Direction Reversal Test — Does signal direction matter?
 *
 * Takes the 36 actual backtest trades and flips all directions:
 *   SHORT → LONG  /  LONG → SHORT
 *
 * Uses the SAME entry dates, assets, leverage, and risk params — only direction flipped.
 *
 * If governance bearish signals are real:    reversed should LOSE money
 * If reversed also profits:                  direction doesn't matter — just timing/event alpha
 */

import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import { readFileSync } from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH   = path.join(__dirname, '../data/backtest.db')
const TRADES    = JSON.parse(readFileSync(path.join(__dirname, '../data/backtest-trades.json'), 'utf8'))

const INITIAL_PORTFOLIO = 100_000
const TICK_MS           = 3_600_000
const TAKER_FEE         = 0.0005
const BASE_SLIPPAGE     = 0.0003
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

function simulate(db, trade, direction) {
  const { asset, leverage, sizePct,
          stopLossPct, takeProfitPct,
          trailingStopActivation, trailingStopDistance,
          maxHoldingHours } = trade.signal

  const sym          = asset.toUpperCase()
  const maxHoldingMs = maxHoldingHours * 3_600_000
  const margin       = INITIAL_PORTFOLIO * (sizePct / 100)
  const notional     = margin * leverage
  const maxLoss      = INITIAL_PORTFOLIO * 0.10
  const entryTs      = trade.openedAt

  const rawEntry = getPrice(db, sym, entryTs)
  if (!rawEntry) return null

  const entryPrice = direction === 'short'
    ? rawEntry * (1 - fee(sym))
    : rawEntry * (1 + fee(sym))

  let peakPnlPct     = 0
  let trailingActive = false

  for (let dt = TICK_MS; dt <= maxHoldingMs; dt += TICK_MS) {
    const price = getPrice(db, sym, entryTs + dt)
    if (!price) continue

    const changePct = direction === 'short'
      ? (entryPrice - price) / entryPrice
      : (price - entryPrice) / entryPrice

    if (changePct > peakPnlPct) peakPnlPct = changePct

    const pnl          = changePct * notional
    const holdingHours = dt / 3_600_000

    if (pnl < -maxLoss) {
      return { pnl: pnl - notional * fee(sym), reason: 'max-loss-cap' }
    }

    let effSL = stopLossPct
    if (changePct < 0 && holdingHours > 336) {
      const decay = Math.min(3, (holdingHours - 336) / 168)
      effSL = stopLossPct * Math.max(0.65, 1.0 - decay * 0.117)
    }
    if (holdingHours >= 72 && changePct < -effSL) {
      return { pnl: pnl - notional * fee(sym), reason: 'stop-loss' }
    }

    if (pnl <= -margin * 0.90) {
      return { pnl: pnl - notional * fee(sym), reason: 'liquidation' }
    }

    if (changePct >= takeProfitPct) {
      return { pnl: pnl - notional * fee(sym), reason: 'take-profit' }
    }

    const capTrail = Math.min(trailingStopDistance, 0.05)
    if (!trailingActive && changePct >= trailingStopActivation) trailingActive = true
    if (trailingActive) {
      const effTrail = peakPnlPct >= trailingStopActivation * 2 ? capTrail * 0.75 : capTrail
      if (peakPnlPct - changePct >= effTrail) {
        return { pnl: pnl - notional * fee(sym), reason: 'trailing-stop' }
      }
    }
  }

  const finalPrice = getPrice(db, sym, entryTs + maxHoldingMs)
  if (!finalPrice) return null
  const finalChange = direction === 'short'
    ? (entryPrice - finalPrice) / entryPrice
    : (finalPrice - entryPrice) / entryPrice
  return { pnl: finalChange * notional - notional * fee(sym), reason: 'max-holding' }
}

// ─── Main ────────────────────────────────────────────────────────────

const db = new Database(DB_PATH, { readonly: true })

let actualTotal = 0, reversedTotal = 0
let actWins = 0, actLosses = 0, revWins = 0, revLosses = 0

const rows = []

for (const trade of TRADES) {
  const origDir  = trade.direction
  const revDir   = origDir === 'short' ? 'long' : 'short'
  const origPnl  = trade.pnl ?? 0

  const revResult = simulate(db, trade, revDir)
  const revPnl    = revResult?.pnl ?? 0

  actualTotal   += origPnl
  reversedTotal += revPnl

  origPnl > 0 ? actWins++ : actLosses++
  revPnl > 0  ? revWins++ : revLosses++

  rows.push({
    asset:    trade.signal.asset.padEnd(8),
    origDir:  origDir.padEnd(6),
    origPnl:  origPnl.toFixed(0),
    revDir:   revDir.padEnd(6),
    revPnl:   revPnl.toFixed(0),
    reason:   revResult?.reason ?? 'no-data',
  })
}

db.close()

// ─── Output ──────────────────────────────────────────────────────────

console.log('Direction Reversal Test — same dates, flipped direction\n')
console.log('Asset     Orig     Actual P&L   Reversed    Rev P&L   Rev Exit')
console.log('─'.repeat(72))

for (const r of rows) {
  const os = parseFloat(r.origPnl) >= 0 ? '+' : ''
  const rs = parseFloat(r.revPnl)  >= 0 ? '+' : ''
  console.log(
    `${r.asset} ${r.origDir} ${(os + r.origPnl).padStart(11)}   ` +
    `${r.revDir} ${(rs + r.revPnl).padStart(11)}   ${r.reason}`
  )
}

const directionAlpha = actualTotal - reversedTotal
const actWR = (actWins / (actWins + actLosses) * 100).toFixed(0)
const revWR = (revWins / (revWins + revLosses) * 100).toFixed(0)

console.log('\n══════════════════════════════════════════════════')
console.log('  DIRECTION REVERSAL RESULTS')
console.log('══════════════════════════════════════════════════')
console.log(`Actual (short) P&L:    $${actualTotal.toFixed(0).padStart(9)}   WR ${actWR}% (${actWins}W / ${actLosses}L)`)
console.log(`Reversed (long) P&L:   $${reversedTotal.toFixed(0).padStart(9)}   WR ${revWR}% (${revWins}W / ${revLosses}L)`)
console.log('──────────────────────────────────────────────────')
console.log(`Direction alpha value: $${directionAlpha.toFixed(0).padStart(9)}   (actual − reversed)`)
console.log('══════════════════════════════════════════════════')

if (reversedTotal < 0 && actualTotal > 0) {
  console.log('\n✓  Reversed direction LOSES money → governance bearish signals are REAL')
  console.log('   The NLP direction prediction adds genuine alpha')
} else if (reversedTotal > 0 && reversedTotal > actualTotal * 0.5) {
  console.log('\n⚠  Reversed direction also profitable → direction signal is WEAK')
  console.log('   Alpha comes from event timing/selection, not directional prediction')
  console.log('   The strategy is essentially "trade any governance event" not "short bad ones"')
} else if (reversedTotal > 0 && reversedTotal < actualTotal * 0.3) {
  console.log('\n~  Mixed: reversed mildly profitable, but actual much better')
  console.log('   Market regime contributes, but direction adds meaningful value')
}
