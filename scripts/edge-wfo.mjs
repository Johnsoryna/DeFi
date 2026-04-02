/**
 * Walk-Forward validation + extended boost sweep for Risk-ONLY filter.
 * Tests boost values 0.10–0.30 and validates across 6 out-of-sample periods.
 */
import { execSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const REPORT = path.join(ROOT, 'data', 'backtest-report.json')
const SCORER = path.join(ROOT, 'src', 'strategy', 'confidenceScorer.ts')

function runBacktest(from, to) {
  execSync(`npx tsx src/backtest/index.ts --from ${from} --to ${to}`, {
    cwd: ROOT, stdio: 'ignore', timeout: 300_000,
  })
  const r = JSON.parse(readFileSync(REPORT, 'utf8'))
  return {
    trades: r.summary.executedTrades,
    pnl: Math.round(r.summary.totalPnl),
    wr: r.performance.winRate,
    pf: r.performance.profitFactor,
  }
}

function readScorer() { return readFileSync(SCORER, 'utf8') }
function writeScorer(s) { writeFileSync(SCORER, s) }
function setBoost(src, boost) {
  return src.replace(
    /const riskOnlyBoost = hasRiskAction && !hasDirectionalValue && direction === 'short' \? [\d.]+/,
    `const riskOnlyBoost = hasRiskAction && !hasDirectionalValue && direction === 'short' ? ${boost}`,
  )
}

const origSrc = readScorer()

// ── Walk-Forward periods (6 out-of-sample months) ─────────────────────
const WFO_PERIODS = [
  { from: '2025-01-01', to: '2025-03-31', label: 'Q1-2025' },
  { from: '2025-04-01', to: '2025-06-30', label: 'Q2-2025' },
  { from: '2025-07-01', to: '2025-09-30', label: 'Q3-2025' },
  { from: '2025-10-01', to: '2025-12-31', label: 'Q4-2025' },
  { from: '2026-01-01', to: '2026-02-20', label: 'Q1-2026' },
]

// ── Extended boost sweep ───────────────────────────────────────────────
const BOOSTS = [0, 0.08, 0.10, 0.12, 0.15, 0.18, 0.20, 0.25, 0.30]

console.log('═══════════════════════════════════════════════════════════')
console.log(' Walk-Forward Validation + Extended Boost Sweep')
console.log('═══════════════════════════════════════════════════════════')

// ── Part 1: Extended boost sweep (full period) ─────────────────────────
console.log('\n[1] Extended boost sweep (full 13-month period)...')
const fullResults = []
for (const boost of BOOSTS) {
  writeScorer(setBoost(origSrc, boost))
  const r = runBacktest('2025-01-01', '2026-02-20')
  console.log(`   boost=${String(boost).padEnd(5)}: PnL=$${r.pnl.toLocaleString()} T=${r.trades} WR=${r.wr}% PF=${r.pf}`)
  fullResults.push({ boost, ...r })
}
writeScorer(origSrc)

// ── Part 2: Walk-Forward per period per boost ──────────────────────────
console.log('\n[2] Walk-Forward per quarter (boost=0 vs boost=0.15)...')
const wfoResults = []
for (const boost of [0, 0.10, 0.15, 0.20]) {
  writeScorer(setBoost(origSrc, boost))
  const periodResults = []
  for (const p of WFO_PERIODS) {
    const r = runBacktest(p.from, p.to)
    periodResults.push({ period: p.label, ...r })
    console.log(`   boost=${boost} ${p.label}: PnL=$${r.pnl.toLocaleString()} T=${r.trades} WR=${r.wr}%`)
  }
  wfoResults.push({ boost, periods: periodResults })
}
writeScorer(origSrc)

// ── Part 3: Analyse which trades are affected by boost ─────────────────
console.log('\n[3] Identifying risk-only vs directional trades...')
// Read trades at boost=0 and boost=0.15 to compare sizing
writeScorer(setBoost(origSrc, 0))
runBacktest('2025-01-01', '2026-02-20')
const tradesNoBoost = JSON.parse(readFileSync(path.join(ROOT, 'data', 'backtest-trades.json'), 'utf8'))

writeScorer(setBoost(origSrc, 0.15))
runBacktest('2025-01-01', '2026-02-20')
const tradesWithBoost = JSON.parse(readFileSync(path.join(ROOT, 'data', 'backtest-trades.json'), 'utf8'))
writeScorer(origSrc)

const t0 = tradesNoBoost.trades || tradesNoBoost
const t1 = tradesWithBoost.trades || tradesWithBoost
console.log('\n   Trade-level impact (boost=0 vs boost=0.15):')
console.log('   #  Protocol  Asset  PnL@0        PnL@0.15     Delta       Win')
for (let i = 0; i < Math.min(t0.length, t1.length); i++) {
  const a = t0[i], b = t1[i]
  const delta = (b.pnl || 0) - (a.pnl || 0)
  if (Math.abs(delta) > 50) {
    console.log(`   ${String(i+1).padStart(2)} ${(a.protocol||'').padEnd(10)} ${(a.asset||'').padEnd(6)} $${Math.round(a.pnl||0).toLocaleString().padStart(8)} -> $${Math.round(b.pnl||0).toLocaleString().padStart(8)}  Δ${delta >= 0 ? '+' : ''}$${delta.toLocaleString().padStart(8)}  ${(b.pnl||0) > 0 ? 'WIN' : 'LOSS'}`)
  }
}

// ── Summary ─────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════')
console.log(' WFO PASS RATE per boost value')
console.log('═══════════════════════════════════════════════════════════')
for (const { boost, periods } of wfoResults) {
  const profitable = periods.filter(p => p.pnl > 0).length
  const totalPnl = periods.reduce((s, p) => s + p.pnl, 0)
  console.log(`   boost=${boost}: ${profitable}/${periods.length} profitable quarters, total OOS PnL=$${totalPnl.toLocaleString()}`)
}

// Save
writeFileSync(
  path.join(ROOT, 'data', 'edge-wfo-results.json'),
  JSON.stringify({ fullResults, wfoResults, tradeComparison: { noBoost: t0.length, withBoost: t1.length } }, null, 2)
)
console.log('\nSaved: data/edge-wfo-results.json')
