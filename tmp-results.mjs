import { readFileSync } from 'fs'
const r = JSON.parse(readFileSync('data/backtest-report.json', 'utf-8'))
const s = r.summary
const p = r.performance
console.log('=== BACKTEST ERGEBNIS (Jan 2025 - Feb 2026) ===')
console.log('Trades:         ' + s.executedTrades)
console.log('PnL:            $' + s.totalPnl.toFixed(0) + ' (+' + s.totalPnlPct.toFixed(1) + '%)')
console.log('Win Rate:       ' + Number(p.winRate).toFixed(1) + '%')
console.log('Profit Factor:  ' + (p.profitFactor === 999 ? 'Infinity' : Number(p.profitFactor).toFixed(2)))
console.log('Avg PnL/Trade:  $' + Number(p.avgPnlPerTrade).toFixed(0))
console.log('Max Drawdown:   ' + Number(p.maxDrawdownPct).toFixed(1) + '%')
console.log('')
console.log('=== TRADES PRO PROTOKOLL ===')
const byProto = {}
for (const row of (r.byProtocol ?? [])) {
  const proto = row.protocol || 'unknown'
  if (!byProto[proto]) byProto[proto] = { trades: 0, pnl: 0, wins: 0 }
  byProto[proto].trades += Number(row.executionCount ?? row.signalCount ?? 0)
  byProto[proto].pnl += Number(row.totalPnl ?? 0)
}
Object.entries(byProto).sort((a, b) => b[1].pnl - a[1].pnl).forEach(([p, d]) => {
  const wr = d.trades > 0 ? (d.wins / d.trades * 100).toFixed(0) : 'n/a'
  console.log(
    p.padEnd(15),
    (d.trades + ' trades').padEnd(10),
    ('$' + d.pnl.toFixed(0)).padStart(10),
    ('WR ' + wr + (wr === 'n/a' ? '' : '%')).padStart(8)
  )
})
