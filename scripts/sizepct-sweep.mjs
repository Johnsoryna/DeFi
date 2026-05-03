/**
 * maxSizePct sweep — find optimal Kelly cap.
 * Tests: 3%, 5%, 8%, 10%, 12%, 15%, 20%, 25%, 30%
 * Metrics: P&L, WR, Sharpe, MaxDD, PF
 * Full period: Jan 2025 – Feb 2026
 */
import { execSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'

const SCORER_PATH = 'C:/Code/DeFi/src/strategy/confidenceScorer.ts'
const REPORT_PATH = 'C:/Code/DeFi/data/backtest-report.json'
const ORIG = 12

function setSizePct(v) {
  let code = readFileSync(SCORER_PATH, 'utf8')
  code = code.replace(/maxSizePct:\s*\d+,/, `maxSizePct: ${v},`)
  writeFileSync(SCORER_PATH, code, 'utf8')
}

function restore() { setSizePct(ORIG) }
process.on('exit', restore)
process.on('SIGINT', () => { restore(); process.exit(1) })
process.on('uncaughtException', (e) => { console.error(e); restore(); process.exit(1) })

function run() {
  execSync('npx tsx src/backtest/index.ts --from 2025-01-01 --to 2026-02-20',
    { cwd: 'C:/Code/DeFi', stdio: 'ignore', timeout: 300000 })
  const r = JSON.parse(readFileSync(REPORT_PATH, 'utf8'))
  return {
    trades: r.summary.executedTrades,
    pnl:    Math.round(r.summary.totalPnl),
    pct:    r.summary.totalPnlPct?.toFixed(1) ?? '?',
    wr:     (r.performance.winRate * 100).toFixed(1),
    sharpe: r.performance.sharpeRatio?.toFixed(2) ?? '?',
    maxdd:  r.performance.maxDrawdownPct?.toFixed(1) ?? '?',
    pf:     r.performance.profitFactor?.toFixed(2) ?? '?',
  }
}

const values = [3, 5, 8, 10, 12, 15, 20, 25, 30]

console.log('maxSizePct sweep — Jan 2025–Feb 2026\n')
console.log('  cap   trades  WR      P&L         pct    Sharpe  MaxDD   PF')
console.log('  ' + '─'.repeat(70))

for (const v of values) {
  process.stdout.write(`  ${String(v + '%').padEnd(6)}`)
  setSizePct(v)
  try {
    const r = run()
    const marker = v === ORIG ? ' ← current' : ''
    console.log(
      `${String(r.trades).padStart(4)}    ` +
      `${r.wr.padStart(5)}%   ` +
      `$${String(r.pnl.toLocaleString()).padStart(9)}   ` +
      `${r.pct.padStart(5)}%   ` +
      `${r.sharpe.padStart(6)}  ` +
      `${r.maxdd.padStart(5)}%  ` +
      `${r.pf.padStart(5)}` +
      marker
    )
  } catch (e) {
    console.log(`ERROR: ${e.message}`)
  }
}

restore()
console.log('\nDone. confidenceScorer.ts restored to maxSizePct: 12')
