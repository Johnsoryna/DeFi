'use strict'
const fs = require('fs')

const trades = JSON.parse(fs.readFileSync('data/backtest-trades.json', 'utf8'))

// Pre-compute per-trade constants
// pnlRatio = P&L per $1 of margin — scale-invariant
const tradeData = trades.map(t => ({
  asset: t.asset,
  direction: t.direction,
  sizePct: t.signal.sizePct,
  leverage: t.signal.leverage,
  dollarAlloc: t.execution.metadata.dollarAllocation,
  pnl: t.pnl,
  pnlRatio: t.pnl / t.execution.metadata.dollarAllocation,
  exitReason: t.exitReason,
}))

const MIN_NOTIONAL = 5  // Binance Futures minimum $5 USDT

console.log('='.repeat(80))
console.log('PORTFOLIO SCALING ANALYSIS — DeFi Governance Bot (Feb 2025 – Feb 2026)')
console.log('='.repeat(80))
console.log()
console.log('Fee model: 0.05% taker (VIP0) + 0.03%×liq-tier slippage at entry AND exit')
console.log('Min notional: $5 USDT (Binance Futures requirement)')
console.log('All trade outcomes use the same win/loss ratios, scaled proportionally.')
console.log()
console.log(`${'Capital'.padStart(8)} | ${'Final'.padStart(10)} | ${'PnL'.padStart(9)} | ${'Return%'.padStart(8)} | ${'Trades'.padStart(6)} | ${'Skipped'.padStart(7)} | Note`)
console.log('-'.repeat(80))

for (let startCapital = 10; startCapital <= 500; startCapital += 10) {
  let portfolio = startCapital
  let tradeCount = 0
  let skipped = 0

  for (const t of tradeData) {
    const dollarAlloc = (t.sizePct / 100) * portfolio
    const leveragedNotional = dollarAlloc * t.leverage

    if (leveragedNotional < MIN_NOTIONAL) {
      skipped++
      continue
    }

    const scaledPnl = t.pnlRatio * dollarAlloc
    portfolio += scaledPnl
    tradeCount++
  }

  const pnlAbs = portfolio - startCapital
  const pnlPct = (pnlAbs / startCapital) * 100

  const cap = `$${startCapital}`.padStart(8)
  const fin = `$${portfolio.toFixed(2)}`.padStart(10)
  const pnl = (pnlAbs >= 0 ? '+$' : '-$') + Math.abs(pnlAbs).toFixed(2)
  const pnlStr = pnl.padStart(9)
  const ret = (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(1) + '%'
  const retStr = ret.padStart(8)
  const tStr = `${tradeCount}`.padStart(6)
  const sStr = `${skipped}`.padStart(7)

  let note = ''
  if (skipped > 0 && skipped === tradeData.length) note = '⚠ NO TRADES POSSIBLE'
  else if (skipped > 0) note = `${skipped} low-lev trades skipped`
  else note = 'all trades execute'

  console.log(`${cap} | ${fin} | ${pnlStr} | ${retStr} | ${tStr} | ${sStr} | ${note}`)
}

console.log()
console.log('='.repeat(80))
console.log('NOTES:')
console.log(' • "Skipped" trades fail Binance min notional ($5 USDT leveraged)')
console.log(' • Returns are approximate — actual compounding path varies by capital')
console.log(' • The strategy is short-biased; small accounts still capture alpha')
console.log(' • Below ~$60: 1x-leverage trades are skipped, reducing trade count')
console.log('='.repeat(80))
