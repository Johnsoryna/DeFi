/**
 * Robustness validation — run multiple overlapping time windows
 * to verify the strategy isn't sensitive to specific start/end dates.
 */
import { execSync } from 'child_process'
import fs from 'fs'

interface Report {
  summary: { totalPnl: number; totalPnlPct: number; executedTrades: number }
  performance: { winRate: number; sharpeRatio: number; maxDrawdownPct: number; worstTrade: number; profitFactor: number; bestTrade: number }
}

const windows = [
  { from: '2025-02-01', to: '2025-12-31', label: 'Full Year (Feb-Dec)' },
  { from: '2025-02-01', to: '2025-06-30', label: 'H1 (Feb-Jun)' },
  { from: '2025-07-01', to: '2025-12-31', label: 'H2 (Jul-Dec)' },
  { from: '2025-03-01', to: '2025-08-31', label: 'Offset (Mar-Aug)' },
  { from: '2025-04-01', to: '2025-09-30', label: 'Offset (Apr-Sep)' },
  { from: '2025-05-01', to: '2025-10-31', label: 'Offset (May-Oct)' },
  { from: '2025-06-01', to: '2025-11-30', label: 'Offset (Jun-Nov)' },
  { from: '2025-02-01', to: '2025-07-31', label: 'First 6m (Feb-Jul)' },
  { from: '2025-05-01', to: '2025-12-31', label: 'Last 8m (May-Dec)' },
]

console.log('=' .repeat(110))
console.log('  ROBUSTNESS VALIDATION — Multiple Time Windows')
console.log('=' .repeat(110))
console.log()
console.log(`${'Window'.padEnd(28)} | ${'Trades'.padStart(6)} | ${'WinRate'.padStart(7)} | ${'PnL'.padStart(10)} | ${'PnL%'.padStart(7)} | ${'Sharpe'.padStart(7)} | ${'MaxDD%'.padStart(7)} | ${'Worst'.padStart(8)} | ${'PF'.padStart(5)}`)
console.log('-'.repeat(110))

for (const w of windows) {
  try {
    execSync(`npx tsx src/backtest/index.ts run --from ${w.from} --to ${w.to}`, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60000,
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer
    })
    const report: Report = JSON.parse(fs.readFileSync('./data/backtest-report.json', 'utf-8'))
    const s = report.summary
    const p = report.performance
    console.log(
      `${w.label.padEnd(28)} | ${String(s.executedTrades).padStart(6)} | ${(p.winRate.toFixed(1) + '%').padStart(7)} | ${('$' + s.totalPnl.toFixed(0)).padStart(10)} | ${(s.totalPnlPct.toFixed(1) + '%').padStart(7)} | ${p.sharpeRatio.toFixed(2).padStart(7)} | ${(p.maxDrawdownPct.toFixed(1) + '%').padStart(7)} | ${('$' + p.worstTrade.toFixed(0)).padStart(8)} | ${p.profitFactor.toFixed(2).padStart(5)}`
    )
  } catch (e) {
    console.log(`${w.label.padEnd(28)} | ERROR: ${(e as Error).message?.slice(0, 50)}`)
  }
}

console.log()
console.log('=' .repeat(110))
