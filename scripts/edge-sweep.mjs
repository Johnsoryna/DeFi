/**
 * Systematic edge sweep — tests multiple confidence-scoring enhancements
 * against the governance backtest baseline.
 *
 * Tests:
 *   A) Risk-ONLY boost magnitude (0.04 / 0.06 / 0.08 / 0.10 / 0.12)
 *   B) Discussion-stage threshold (0.48 / 0.50 / 0.52)
 *   C) Snapshot-stage threshold (0.52 / 0.55 / 0.57)
 *   D) Combined: best Risk-ONLY + best thresholds
 *   E) Q2 2025 loss autopsy — do any of the 5 losers share a detectable pattern?
 *
 * Usage: node scripts/edge-sweep.mjs
 */

import { execSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const REPORT = path.join(ROOT, 'data', 'backtest-report.json')
const SCORER = path.join(ROOT, 'src', 'strategy', 'confidenceScorer.ts')

// ─── Helpers ──────────────────────────────────────────────────────────

function runBacktest() {
  execSync('npx tsx src/backtest/index.ts --from 2025-01-01 --to 2026-02-20', {
    cwd: ROOT, stdio: 'ignore', timeout: 300_000,
  })
  const r = JSON.parse(readFileSync(REPORT, 'utf8'))
  return {
    trades: r.summary.executedTrades,
    pnl: Math.round(r.summary.totalPnl),
    wr: r.performance.winRate,
    pf: r.performance.profitFactor,
    sharpe: r.performance.sharpeRatio,
    maxdd: r.performance.maxDrawdownPct,
  }
}

function readScorer() { return readFileSync(SCORER, 'utf8') }
function writeScorer(s) { writeFileSync(SCORER, s) }

function setRiskBoost(src, boost) {
  // Replace the riskOnlyBoost constant value
  return src.replace(
    /const riskOnlyBoost = hasRiskAction && !hasDirectionalValue && direction === 'short' \? [\d.]+/,
    `const riskOnlyBoost = hasRiskAction && !hasDirectionalValue && direction === 'short' ? ${boost}`,
  )
}

function setDiscussionThreshold(src, val) {
  return src.replace(
    /case 'discussion': return [\d.]+/,
    `case 'discussion': return ${val}`,
  )
}

function setSnapshotThreshold(src, val) {
  return src.replace(
    /case 'snapshot': return [\d.]+\s+\/\/ Snapshots/,
    `case 'snapshot': return ${val}    // Snapshots`,
  )
}

function removeRiskBoost(src) {
  // Set boost to 0 (effectively disabling it)
  return setRiskBoost(src, 0)
}

function fmt(r) {
  return `T=${r.trades} PnL=$${r.pnl.toLocaleString()} WR=${r.wr}% PF=${r.pf} Sh=${r.sharpe} DD=${r.maxdd}%`
}

// ─── Run ──────────────────────────────────────────────────────────────

const results = []

console.log('═══════════════════════════════════════════════════════')
console.log(' DeFi Governance Edge Sweep')
console.log('═══════════════════════════════════════════════════════')

const origSrc = readScorer()

// ── BASELINE (Risk-ONLY boost = 0.08 as currently set) ───────────────
console.log('\n[0] Baseline (Risk-ONLY boost=0.08, disc=0.50, snap=0.55)')
const baseline = runBacktest()
console.log('   ', fmt(baseline))
results.push({ label: 'BASELINE (boost=0.08)', ...baseline })

// ── A: Risk-ONLY boost magnitude ─────────────────────────────────────
console.log('\n[A] Risk-ONLY boost magnitude sweep...')
for (const boost of [0, 0.04, 0.06, 0.10, 0.12, 0.15]) {
  const src = setRiskBoost(origSrc, boost)
  writeScorer(src)
  const r = runBacktest()
  console.log(`   boost=${boost}: ${fmt(r)}`)
  results.push({ label: `Risk-ONLY boost=${boost}`, ...r })
}

// Restore original
writeScorer(origSrc)

// ── B: Discussion-stage threshold ────────────────────────────────────
console.log('\n[B] Discussion threshold sweep (Risk-ONLY boost=0.08)...')
for (const disc of [0.46, 0.48, 0.50, 0.52, 0.54]) {
  const src = setDiscussionThreshold(origSrc, disc)
  writeScorer(src)
  const r = runBacktest()
  console.log(`   disc=${disc}: ${fmt(r)}`)
  results.push({ label: `discussion-threshold=${disc}`, ...r })
}

writeScorer(origSrc)

// ── C: Snapshot-stage threshold ───────────────────────────────────────
console.log('\n[C] Snapshot threshold sweep (Risk-ONLY boost=0.08)...')
for (const snap of [0.50, 0.52, 0.53, 0.55, 0.57, 0.58]) {
  const src = setSnapshotThreshold(origSrc, snap)
  writeScorer(src)
  const r = runBacktest()
  console.log(`   snap=${snap}: ${fmt(r)}`)
  results.push({ label: `snapshot-threshold=${snap}`, ...r })
}

writeScorer(origSrc)

// ── D: Combined best combos ───────────────────────────────────────────
console.log('\n[D] Combined combos...')
const combos = [
  { boost: 0.08, disc: 0.48, snap: 0.55 },
  { boost: 0.08, disc: 0.50, snap: 0.53 },
  { boost: 0.10, disc: 0.48, snap: 0.53 },
  { boost: 0.06, disc: 0.50, snap: 0.55 },
  { boost: 0.08, disc: 0.48, snap: 0.53 },
  { boost: 0,    disc: 0.50, snap: 0.55 }, // No Risk-ONLY, original thresholds
]
for (const c of combos) {
  let src = setRiskBoost(origSrc, c.boost)
  src = setDiscussionThreshold(src, c.disc)
  src = setSnapshotThreshold(src, c.snap)
  writeScorer(src)
  const r = runBacktest()
  console.log(`   boost=${c.boost} disc=${c.disc} snap=${c.snap}: ${fmt(r)}`)
  results.push({ label: `combo boost=${c.boost} disc=${c.disc} snap=${c.snap}`, ...r })
}

writeScorer(origSrc)

// ── E: Q2 2025 check ─────────────────────────────────────────────────
console.log('\n[E] Q2 2025 isolated window (Apr-Jun 2025)...')
execSync('npx tsx src/backtest/index.ts --from 2025-04-01 --to 2025-06-30', {
  cwd: ROOT, stdio: 'ignore', timeout: 300_000,
})
const q2 = JSON.parse(readFileSync(REPORT, 'utf8'))
console.log(`   Q2 2025 (current): T=${q2.summary.executedTrades} PnL=$${Math.round(q2.summary.totalPnl)} WR=${q2.performance.winRate}%`)
results.push({ label: 'Q2-2025 baseline', trades: q2.summary.executedTrades, pnl: Math.round(q2.summary.totalPnl), wr: q2.performance.winRate, pf: q2.performance.profitFactor, sharpe: q2.performance.sharpeRatio, maxdd: q2.performance.maxDrawdownPct })

// ── Save results ──────────────────────────────────────────────────────
const out = path.join(ROOT, 'data', 'edge-sweep-results.json')
writeFileSync(out, JSON.stringify({ runDate: new Date().toISOString(), results }, null, 2))

console.log('\n═══════════════════════════════════════════════════════')
console.log(' SUMMARY (sorted by PnL)')
console.log('═══════════════════════════════════════════════════════')
const sorted = [...results].filter(r => !r.label.startsWith('Q2')).sort((a, b) => b.pnl - a.pnl)
sorted.forEach((r, i) => {
  const delta = r.pnl - baseline.pnl
  const sign = delta >= 0 ? '+' : ''
  console.log(`${String(i+1).padStart(2)}. ${r.label.padEnd(45)} PnL=$${r.pnl.toLocaleString()} (${sign}$${delta.toLocaleString()}) T=${r.trades} WR=${r.wr}% PF=${r.pf}`)
})
console.log(`\nResults saved to data/edge-sweep-results.json`)
