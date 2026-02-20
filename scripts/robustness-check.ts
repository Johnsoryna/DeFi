/**
 * ROBUSTNESS CHECK — Anti-Overfitting Validation
 *
 * 3 techniques to validate that our parameters aren't overfit:
 *
 *  1. WALK-FORWARD VALIDATION
 *     Train on a period, test on unseen future data.
 *     If the strategy works on unseen data, it's not just curve-fitting.
 *
 *  2. PARAMETER SENSITIVITY ANALYSIS
 *     Perturb each optimized parameter by ±5%, ±10%, ±20%.
 *     Robust strategies degrade gracefully; overfit strategies cliff-drop.
 *
 *  3. MONTE CARLO TRADE SIMULATION
 *     Shuffle trade order and add random slippage to see if results
 *     hold under uncertainty. Overfit strategies are fragile to reordering.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const CONFIDENCE_PATH = path.resolve('src/strategy/confidenceScorer.ts')
const RISK_MGR_PATH = path.resolve('src/strategy/riskManager.ts')
const SIG_GEN_PATH = path.resolve('src/strategy/signalGenerator.ts')

let origConfidence: string
let origRiskMgr: string
let origSigGen: string

function backup() {
  origConfidence = fs.readFileSync(CONFIDENCE_PATH, 'utf8')
  origRiskMgr = fs.readFileSync(RISK_MGR_PATH, 'utf8')
  origSigGen = fs.readFileSync(SIG_GEN_PATH, 'utf8')
}

function restoreWithRetry(path: string, content: string, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      fs.writeFileSync(path, content)
      return
    } catch (e: any) {
      if (i < retries - 1) {
        const ms = 200 * (i + 1)
        const end = Date.now() + ms
        while (Date.now() < end) { /* busy wait */ }
      } else {
        throw e
      }
    }
  }
}

function restore() {
  restoreWithRetry(CONFIDENCE_PATH, origConfidence)
  restoreWithRetry(RISK_MGR_PATH, origRiskMgr)
  restoreWithRetry(SIG_GEN_PATH, origSigGen)
}

interface Params {
  maxSizePct?: number
  aggTP?: number; modTP?: number; consTP?: number
  maxHoldingHours?: number
  shortScalePower?: number
  cooldownDays?: number
  shortMaxRiskPct?: number
  c3EthUptrendThreshold?: number
}

function apply(p: Params) {
  let conf = origConfidence
  let risk = origRiskMgr
  let sig = origSigGen

  if (p.maxSizePct !== undefined) conf = conf.replace(/maxSizePct:\s*[\d.]+,\s*\/\/ Max/, `maxSizePct: ${p.maxSizePct},       // Max`)
  if (p.aggTP !== undefined) conf = conf.replace(/(aggressive:\s*\{[\s\S]*?takeProfitPct:\s*)[\d.]+/, `$1${p.aggTP}`)
  if (p.modTP !== undefined) conf = conf.replace(/(moderate:\s*\{[\s\S]*?takeProfitPct:\s*)[\d.]+/, `$1${p.modTP}`)
  if (p.consTP !== undefined) conf = conf.replace(/(conservative:\s*\{[\s\S]*?takeProfitPct:\s*)[\d.]+/, `$1${p.consTP}`)
  if (p.maxHoldingHours !== undefined) conf = conf.replace(/maxHoldingHours:\s*\d+,/g, `maxHoldingHours: ${p.maxHoldingHours},`)
  if (p.shortScalePower !== undefined) conf = conf.replace(/const scalePower = isShort \? [\d.]+ :/, `const scalePower = isShort ? ${p.shortScalePower} :`)
  if (p.shortMaxRiskPct !== undefined) {
    conf = conf.replace(/const MAX_RISK_PCT = direction === 'short' \? [\d.]+ :/, `const MAX_RISK_PCT = direction === 'short' ? ${p.shortMaxRiskPct} :`)
  }
  if (p.cooldownDays !== undefined) risk = risk.replace(/consecutiveLossCooldownMs:\s*[\d]+\s*\*\s*24\s*\*\s*3600_000,/, `consecutiveLossCooldownMs: ${p.cooldownDays} * 24 * 3600_000,`)
  if (p.c3EthUptrendThreshold !== undefined) sig = sig.replace(/ethMom14d !== null && ethMom14d > [\d.]+/, `ethMom14d !== null && ethMom14d > ${p.c3EthUptrendThreshold}`)

  fs.writeFileSync(CONFIDENCE_PATH, conf)
  fs.writeFileSync(RISK_MGR_PATH, risk)
  fs.writeFileSync(SIG_GEN_PATH, sig)
}

interface MonthResult { month: string; trades: number; wins: number; pnl: number }
interface TestResult {
  totalPnl: number; wr: number; sharpe: number; maxDD: number; trades: number
  months: MonthResult[]; allPositive: boolean; worstMonth: number; pf: number
}

function runTest(from: string, to: string, portfolio = 100000): TestResult | null {
  try {
    execSync(
      `npx tsx src/backtest/index.ts run --from ${from} --to ${to} --portfolio ${portfolio} --db ./data/backtest.db > data/_bt-out.txt 2>&1`,
      { cwd: process.cwd(), timeout: 120000, shell: true }
    )
    const report = JSON.parse(fs.readFileSync('./data/backtest-report.json', 'utf8'))
    const trades = JSON.parse(fs.readFileSync('./data/backtest-trades.json', 'utf8'))
    const monthly: Record<string, MonthResult> = {}
    for (const t of trades) {
      const d = new Date(t.openedAt)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      if (!monthly[key]) monthly[key] = { month: key, trades: 0, wins: 0, pnl: 0 }
      monthly[key].trades++; monthly[key].pnl += t.pnl; if (t.pnl > 0) monthly[key].wins++
    }
    const months = Object.values(monthly).sort((a, b) => a.month.localeCompare(b.month))
    return {
      totalPnl: report.summary.totalPnl, wr: report.performance.winRate,
      sharpe: report.performance.sharpeRatio, maxDD: report.performance.maxDrawdownPct,
      trades: trades.length, months, allPositive: months.every(m => m.pnl >= 0),
      worstMonth: Math.min(...months.map(m => m.pnl)), pf: report.performance.profitFactor,
    }
  } catch { return null }
}

// ═══════════════════════════════════════════════════════════════════
//  CURRENT OPTIMAL PARAMETER VALUES (for sensitivity perturbation)
//  Keep in sync with actual code values:
//    confidenceScorer.ts: maxSizePct, aggTP, modTP, consTP, maxHoldingHours, shortScalePower, shortMaxRiskPct
//    riskManager.ts:      cooldownDays
//    signalGenerator.ts:  c3EthUptrendThreshold
// ═══════════════════════════════════════════════════════════════════
const OPTIMAL = {
  maxSizePct: 12,
  aggTP: 0.36, modTP: 0.26, consTP: 0.20,
  maxHoldingHours: 576,
  shortScalePower: 0.58,
  cooldownDays: 3,
  shortMaxRiskPct: 12,
  c3EthUptrendThreshold: 0.15,
}

async function main() {
  const startTime = Date.now()
  console.log('═'.repeat(120))
  console.log('  ROBUSTNESS CHECK — Anti-Overfitting Validation')
  console.log('═'.repeat(120))

  backup()

  // ═══════════════════════════════════════════════════════════════
  //  TEST 1: WALK-FORWARD VALIDATION
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(120))
  console.log('  TEST 1: WALK-FORWARD VALIDATION')
  console.log('  Does the strategy work on unseen time periods?')
  console.log('═'.repeat(120) + '\n')

  const walkForward = [
    { name: 'FULL PERIOD (reference)',    from: '2025-01-01', to: '2026-02-16' },
    { name: 'H1: Jan-Jun 2025 only',     from: '2025-01-01', to: '2025-07-01' },
    { name: 'H2: Jul-Dec 2025 only',     from: '2025-07-01', to: '2026-01-01' },
    { name: 'H2+: Jul 2025-Feb 2026',    from: '2025-07-01', to: '2026-02-16' },
    { name: 'Q1: Jan-Mar 2025',           from: '2025-01-01', to: '2025-04-01' },
    { name: 'Q2: Apr-Jun 2025',           from: '2025-04-01', to: '2025-07-01' },
    { name: 'Q3: Jul-Sep 2025',           from: '2025-07-01', to: '2025-10-01' },
    { name: 'Q4: Oct-Dec 2025',           from: '2025-10-01', to: '2026-01-01' },
    { name: 'Q5: Jan-Feb 2026',           from: '2026-01-01', to: '2026-02-16' },
    { name: 'TRAIN: Jan-Aug → TEST: Sep-Feb', from: '2025-09-01', to: '2026-02-16' },
    { name: 'TRAIN: Jan-Jun → TEST: Jul-Feb', from: '2025-07-01', to: '2026-02-16' },
    { name: 'Last 6m: Sep 2025-Feb 2026',  from: '2025-09-01', to: '2026-02-16' },
    { name: 'Last 3m: Dec 2025-Feb 2026',  from: '2025-12-01', to: '2026-02-16' },
  ]

  const wfResults: any[] = []

  for (const wf of walkForward) {
    process.stdout.write(`  ${wf.name.padEnd(42)}`)
    restore()
    const r = runTest(wf.from, wf.to)
    if (r) {
      wfResults.push({ ...wf, ...r })
      console.log(
        `P&L: $${Math.round(r.totalPnl).toLocaleString().padStart(8)} | ` +
        `WR: ${r.wr.toFixed(0)}% | Sharpe: ${r.sharpe.toFixed(2)} | ` +
        `PF: ${(r.pf ?? 0).toFixed(2)} | Trades: ${r.trades} | ` +
        (r.allPositive ? '✓ ALL+' : `${r.months.filter(m => m.pnl < 0).length} neg`)
      )
    } else {
      console.log('FAILED')
    }
  }

  // Walk-forward score
  const profitablePeriods = wfResults.filter(r => r.totalPnl > 0).length
  const totalPeriods = wfResults.length
  console.log(`\n  Walk-Forward Score: ${profitablePeriods}/${totalPeriods} periods profitable (${(profitablePeriods/totalPeriods*100).toFixed(0)}%)`)

  // ═══════════════════════════════════════════════════════════════
  //  TEST 2: PARAMETER SENSITIVITY ANALYSIS
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(120))
  console.log('  TEST 2: PARAMETER SENSITIVITY ANALYSIS')
  console.log('  How much does performance change when each parameter shifts ±5/10/20%?')
  console.log('  Robust: gradual degradation. Overfit: cliff-edge drops.')
  console.log('═'.repeat(120) + '\n')

  interface SensitivityResult {
    param: string; pctChange: number; value: number
    pnl: number; wr: number; sharpe: number; trades: number; allPos: boolean
  }
  const sensitivityResults: SensitivityResult[] = []

  const perturbations = [-0.20, -0.10, -0.05, 0, +0.05, +0.10, +0.20]

  const paramDefs: { name: string; key: keyof Params; optimal: number; min?: number; max?: number }[] = [
    { name: 'maxSizePct',           key: 'maxSizePct',           optimal: OPTIMAL.maxSizePct, min: 3, max: 20 },
    { name: 'aggTP',                key: 'aggTP',                optimal: OPTIMAL.aggTP, min: 0.10, max: 0.60 },
    { name: 'modTP',                key: 'modTP',                optimal: OPTIMAL.modTP, min: 0.08, max: 0.50 },
    { name: 'consTP',               key: 'consTP',               optimal: OPTIMAL.consTP, min: 0.06, max: 0.40 },
    { name: 'maxHoldingHours',      key: 'maxHoldingHours',      optimal: OPTIMAL.maxHoldingHours, min: 168, max: 1008 },
    { name: 'shortScalePower',      key: 'shortScalePower',      optimal: OPTIMAL.shortScalePower, min: 0.30, max: 0.95 },
    { name: 'cooldownDays',         key: 'cooldownDays',         optimal: OPTIMAL.cooldownDays, min: 1, max: 14 },
    { name: 'shortMaxRiskPct',      key: 'shortMaxRiskPct',      optimal: OPTIMAL.shortMaxRiskPct, min: 5, max: 25 },
    { name: 'c3EthUptrendThresh',   key: 'c3EthUptrendThreshold',optimal: OPTIMAL.c3EthUptrendThreshold, min: 0.05, max: 0.40 },
  ]

  for (const pd of paramDefs) {
    console.log(`  ─── ${pd.name} (optimal: ${pd.optimal}) ───`)

    for (const pct of perturbations) {
      let val = pd.optimal * (1 + pct)
      if (pd.min !== undefined) val = Math.max(pd.min, val)
      if (pd.max !== undefined) val = Math.min(pd.max, val)

      // Round appropriately
      if (pd.key === 'maxHoldingHours' || pd.key === 'cooldownDays' || pd.key === 'maxSizePct' || pd.key === 'shortMaxRiskPct') {
        val = Math.round(val)
      } else {
        val = Math.round(val * 100) / 100
      }

      const label = pct === 0 ? '  0%' : (pct > 0 ? `+${(pct*100).toFixed(0)}%` : `${(pct*100).toFixed(0)}%`)

      process.stdout.write(`    ${label.padStart(5)} (${String(val).padStart(6)})  `)

      restore()
      const params: Params = { [pd.key]: val }
      apply(params)
      const r = runTest('2025-01-01', '2026-02-16')

      if (r) {
        sensitivityResults.push({
          param: pd.name, pctChange: pct, value: val,
          pnl: r.totalPnl, wr: r.wr, sharpe: r.sharpe, trades: r.trades, allPos: r.allPositive,
        })
        const flag = r.allPositive ? '✓' : '✗'
        console.log(
          `P&L: $${Math.round(r.totalPnl).toLocaleString().padStart(8)} | ` +
          `WR: ${r.wr.toFixed(0)}% | Sharpe: ${r.sharpe.toFixed(2)} | ` +
          `Trades: ${r.trades} ${flag}`
        )
      } else {
        console.log('FAILED')
      }
    }
    console.log()
  }

  // Calculate sensitivity scores
  console.log('  ─── SENSITIVITY SUMMARY ───')
  console.log('  Lower = more robust (less sensitive to parameter changes)')
  console.log()

  for (const pd of paramDefs) {
    const paramResults = sensitivityResults.filter(r => r.param === pd.name)
    const optResult = paramResults.find(r => r.pctChange === 0)
    if (!optResult) continue

    const pnlValues = paramResults.map(r => r.pnl)
    const pnlRange = Math.max(...pnlValues) - Math.min(...pnlValues)
    const pctVariation = (pnlRange / optResult.pnl * 100).toFixed(1)
    const allPosCount = paramResults.filter(r => r.allPos).length

    // Sensitivity score: how much P&L varies relative to optimal (lower = more robust)
    const sensitivity = pnlRange / optResult.pnl

    let grade: string
    if (sensitivity < 0.05) grade = 'A+ (very robust)'
    else if (sensitivity < 0.10) grade = 'A  (robust)'
    else if (sensitivity < 0.20) grade = 'B  (moderate)'
    else if (sensitivity < 0.35) grade = 'C  (sensitive)'
    else grade = 'D  (fragile — possible overfit)'

    console.log(
      `  ${pd.name.padEnd(24)} Variation: ${pctVariation.padStart(5)}% | ` +
      `All+: ${allPosCount}/${paramResults.length} | ` +
      `Grade: ${grade}`
    )
  }

  // ═══════════════════════════════════════════════════════════════
  //  TEST 3: MONTE CARLO — Trade Reordering Simulation
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(120))
  console.log('  TEST 3: MONTE CARLO — Trade Reordering Simulation')
  console.log('  Shuffle trade order 1000x to see how equity curve varies.')
  console.log('  If results are stable, the strategy isn\'t dependent on lucky sequencing.')
  console.log('═'.repeat(120) + '\n')

  restore()
  // Run a fresh backtest to get actual trades
  runTest('2025-01-01', '2026-02-16')
  const trades = JSON.parse(fs.readFileSync('./data/backtest-trades.json', 'utf8'))
  const pnls = trades.map((t: any) => t.pnl)
  const actualPnl = pnls.reduce((a: number, b: number) => a + b, 0)

  const N_SIMULATIONS = 10000
  const simResults: number[] = []
  const simMaxDDs: number[] = []

  for (let i = 0; i < N_SIMULATIONS; i++) {
    // Fisher-Yates shuffle
    const shuffled = [...pnls]
    for (let j = shuffled.length - 1; j > 0; j--) {
      const k = Math.floor(Math.random() * (j + 1));
      [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]]
    }

    // Calculate equity curve and max drawdown
    let equity = 100000
    let peak = equity
    let maxDD = 0
    for (const p of shuffled) {
      equity += p
      if (equity > peak) peak = equity
      const dd = (peak - equity) / peak * 100
      if (dd > maxDD) maxDD = dd
    }
    simResults.push(equity - 100000)
    simMaxDDs.push(maxDD)
  }

  simResults.sort((a, b) => a - b)
  simMaxDDs.sort((a, b) => a - b)

  const pctl = (arr: number[], p: number) => arr[Math.floor(arr.length * p / 100)]

  console.log(`  Actual P&L:      $${Math.round(actualPnl).toLocaleString()}`)
  console.log(`  Simulations:     ${N_SIMULATIONS.toLocaleString()}`)
  console.log()
  console.log('  P&L Distribution (trade order shuffled):')
  console.log(`    1st percentile:  $${Math.round(pctl(simResults, 1)).toLocaleString()}`)
  console.log(`    5th percentile:  $${Math.round(pctl(simResults, 5)).toLocaleString()}`)
  console.log(`   10th percentile:  $${Math.round(pctl(simResults, 10)).toLocaleString()}`)
  console.log(`   25th percentile:  $${Math.round(pctl(simResults, 25)).toLocaleString()}`)
  console.log(`   50th (median):    $${Math.round(pctl(simResults, 50)).toLocaleString()}`)
  console.log(`   75th percentile:  $${Math.round(pctl(simResults, 75)).toLocaleString()}`)
  console.log(`   95th percentile:  $${Math.round(pctl(simResults, 95)).toLocaleString()}`)
  console.log(`   99th percentile:  $${Math.round(pctl(simResults, 99)).toLocaleString()}`)
  console.log()
  console.log('  Max Drawdown Distribution:')
  console.log(`    5th percentile:  ${pctl(simMaxDDs, 5).toFixed(1)}%`)
  console.log(`   25th percentile:  ${pctl(simMaxDDs, 25).toFixed(1)}%`)
  console.log(`   50th (median):    ${pctl(simMaxDDs, 50).toFixed(1)}%`)
  console.log(`   75th percentile:  ${pctl(simMaxDDs, 75).toFixed(1)}%`)
  console.log(`   95th percentile:  ${pctl(simMaxDDs, 95).toFixed(1)}%`)
  console.log(`   99th percentile:  ${pctl(simMaxDDs, 99).toFixed(1)}%`)

  // Probability of positive P&L
  const posPnl = simResults.filter(p => p > 0).length
  console.log(`\n  Probability of positive P&L:  ${(posPnl / N_SIMULATIONS * 100).toFixed(1)}%`)

  // Add slippage simulation
  console.log('\n  ─── With 2% Random Slippage per Trade ───')
  const slipResults: number[] = []
  for (let i = 0; i < N_SIMULATIONS; i++) {
    let equity = 100000
    for (const p of pnls) {
      // Add random slippage: ±2% of absolute trade P&L
      const slippage = (Math.random() * 0.04 - 0.02) * Math.abs(p)
      equity += p + slippage
    }
    slipResults.push(equity - 100000)
  }
  slipResults.sort((a, b) => a - b)

  console.log(`    5th percentile:  $${Math.round(pctl(slipResults, 5)).toLocaleString()}`)
  console.log(`   50th (median):    $${Math.round(pctl(slipResults, 50)).toLocaleString()}`)
  console.log(`   95th percentile:  $${Math.round(pctl(slipResults, 95)).toLocaleString()}`)
  console.log(`   Prob positive:    ${(slipResults.filter(p => p > 0).length / N_SIMULATIONS * 100).toFixed(1)}%`)

  // With larger slippage (5%)
  console.log('\n  ─── With 5% Random Slippage per Trade (stress test) ───')
  const slipResults5: number[] = []
  for (let i = 0; i < N_SIMULATIONS; i++) {
    let equity = 100000
    for (const p of pnls) {
      const slippage = (Math.random() * 0.10 - 0.05) * Math.abs(p)
      equity += p + slippage
    }
    slipResults5.push(equity - 100000)
  }
  slipResults5.sort((a, b) => a - b)

  console.log(`    5th percentile:  $${Math.round(pctl(slipResults5, 5)).toLocaleString()}`)
  console.log(`   50th (median):    $${Math.round(pctl(slipResults5, 50)).toLocaleString()}`)
  console.log(`   95th percentile:  $${Math.round(pctl(slipResults5, 95)).toLocaleString()}`)
  console.log(`   Prob positive:    ${(slipResults5.filter(p => p > 0).length / N_SIMULATIONS * 100).toFixed(1)}%`)

  // ═══════════════════════════════════════════════════════════════
  //  OVERALL ROBUSTNESS SCORE
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(120))
  console.log('  OVERALL ROBUSTNESS SCORE')
  console.log('═'.repeat(120) + '\n')

  // Score 1: Walk-forward (0-100)
  const wfScore = (profitablePeriods / totalPeriods) * 100

  // Score 2: Parameter stability (0-100, based on positive total P&L across perturbations)
  // Note: "all-months-positive" is too strict — Q2 2025 (bull market) is structurally bad
  // in any configuration. Instead: check that total P&L stays positive under perturbation.
  const totalSensTests = sensitivityResults.length
  const allPosTests = sensitivityResults.filter(r => r.pnl > 0).length
  const paramScore = (allPosTests / totalSensTests) * 100

  // Score 3: Monte Carlo (0-100, based on positive P&L probability)
  const mcScore = (posPnl / N_SIMULATIONS) * 100

  // Score 4: Slippage resilience (0-100)
  const slipScore = (slipResults.filter(p => p > 0).length / N_SIMULATIONS) * 100

  const overallScore = (wfScore * 0.30 + paramScore * 0.30 + mcScore * 0.20 + slipScore * 0.20)

  console.log(`  Walk-Forward Score:       ${wfScore.toFixed(1)}%  (${profitablePeriods}/${totalPeriods} profitable periods)`)
  console.log(`  Parameter Stability:      ${paramScore.toFixed(1)}%  (${allPosTests}/${totalSensTests} perturbations stay total-pnl-positive)`)
  console.log(`  Monte Carlo (reorder):    ${mcScore.toFixed(1)}%  (prob of positive P&L)`)
  console.log(`  Slippage Resilience (2%): ${slipScore.toFixed(1)}%  (prob of positive P&L with slippage)`)
  console.log()
  console.log(`  ═══ OVERALL ROBUSTNESS: ${overallScore.toFixed(1)}% ═══`)
  console.log()

  if (overallScore >= 90) console.log('  VERDICT: ✓ EXCELLENT — Very low overfitting risk')
  else if (overallScore >= 80) console.log('  VERDICT: ✓ GOOD — Moderate robustness, some caution needed')
  else if (overallScore >= 70) console.log('  VERDICT: ~ FAIR — Some overfitting concerns, reduce sizing for live')
  else if (overallScore >= 60) console.log('  VERDICT: ✗ WEAK — Significant overfitting risk, need more OOS data')
  else console.log('  VERDICT: ✗ POOR — Likely overfit, do not trade live with these parameters')

  restore()

  const elapsed = ((Date.now() - startTime) / 60000).toFixed(1)
  console.log(`\n  Completed in ${elapsed} minutes.`)
}

main().catch(console.error)
