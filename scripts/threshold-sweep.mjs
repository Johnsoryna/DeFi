/**
 * Threshold sweep: vary min-confidence from 0.50 down to 0.25
 * and record trades/PnL/WR at each step.
 * Shows the quality vs quantity trade-off.
 */
import { execSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'

const SCORER_PATH = 'C:/Code/DeFi/src/strategy/confidenceScorer.ts'
const REPORT_PATH = 'C:/Code/DeFi/data/backtest-report.json'

const ORIG_DISC = 0.50
const ORIG_SNAP = 0.55

function setThresholds(disc, snap) {
  let code = readFileSync(SCORER_PATH, 'utf8')
  // Replace discussion threshold
  code = code.replace(
    /case 'discussion': return 0\.\d+/,
    `case 'discussion': return ${disc.toFixed(2)}`
  )
  // Replace snapshot threshold (keep the comment if present)
  code = code.replace(
    /case 'snapshot': return 0\.\d+/,
    `case 'snapshot': return ${snap.toFixed(2)}`
  )
  writeFileSync(SCORER_PATH, code, 'utf8')
}

function runBacktest() {
  execSync(
    'npx tsx src/backtest/index.ts --from 2025-01-01 --to 2026-02-20',
    { cwd: 'C:/Code/DeFi', stdio: 'ignore', timeout: 180000 }
  )
  const r = JSON.parse(readFileSync(REPORT_PATH, 'utf8'))
  return {
    trades: r.summary.executedTrades,
    pnl:    r.summary.totalPnl,
    pct:    r.summary.totalPnlPct,
    wr:     r.performance.winRate,
    sharpe: r.performance.sharpeRatio,
    maxdd:  r.performance.maxDrawdownPct,
    pf:     r.performance.profitFactor,
  }
}

// Always restore on exit
function restore() { setThresholds(ORIG_DISC, ORIG_SNAP) }
process.on('exit', restore)
process.on('SIGINT', () => { restore(); process.exit(1) })
process.on('uncaughtException', (e) => { console.error(e); restore(); process.exit(1) })

// Sweep configuration: [discussion, snapshot]
// snapshot stays slightly higher than discussion (matching original pattern)
const sweep = [
  [0.50, 0.55],
  [0.48, 0.50],
  [0.45, 0.48],
  [0.43, 0.45],
  [0.40, 0.43],
  [0.38, 0.40],
  [0.35, 0.38],
  [0.33, 0.35],
  [0.30, 0.33],
  [0.27, 0.30],
  [0.25, 0.27],
]

const results = []

console.log('\n=== Threshold Sweep: Quality vs Quantity ===')
console.log('disc/snap  | Trades |      PnL | Return |    WR | Sharpe |  MaxDD |   PF')
console.log('-'.repeat(72))

for (const [disc, snap] of sweep) {
  const label = `${disc.toFixed(2)}/${snap.toFixed(2)}`
  process.stdout.write(label.padEnd(10) + ' | ')

  setThresholds(disc, snap)
  const r = runBacktest()
  results.push({ disc, snap, ...r })

  const pnlStr  = ('$' + r.pnl.toFixed(0)).padStart(8)
  const pctStr  = ('+' + r.pct.toFixed(1) + '%').padStart(6)
  const wrStr   = (r.wr.toFixed(1) + '%').padStart(5)
  const shrStr  = r.sharpe.toFixed(2).padStart(6)
  const ddStr   = (r.maxdd.toFixed(1) + '%').padStart(6)
  const pfStr   = (r.pf === 999 ? 'inf' : r.pf.toFixed(2)).padStart(4)

  console.log(`${String(r.trades).padStart(6)} | ${pnlStr} | ${pctStr} | ${wrStr} | ${shrStr} | ${ddStr} | ${pfStr}`)
}

restore()

// Summary
const base = results[0]
console.log('\n=== Kosten jedes zusätzlichen Trades (vs Baseline 36 trades) ===')
for (const r of results.slice(1)) {
  const extraTrades = r.trades - base.trades
  if (extraTrades <= 0) continue
  const pnlDelta = r.pnl - base.pnl
  const costPer  = pnlDelta / extraTrades
  const sign     = pnlDelta >= 0 ? '+' : ''
  console.log(
    `  ${r.disc.toFixed(2)}/${r.snap.toFixed(2)}: ` +
    `+${extraTrades} Trades, ` +
    `PnL ${sign}$${pnlDelta.toFixed(0)} (${costPer >= 0 ? '+' : ''}$${costPer.toFixed(0)}/Trade), ` +
    `WR ${r.wr.toFixed(1)}%, MaxDD ${r.maxdd.toFixed(1)}%`
  )
}
console.log('\nThresholds restored to 0.50/0.55.')
