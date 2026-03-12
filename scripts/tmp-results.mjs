import { readFileSync } from 'fs'
const trades = JSON.parse(readFileSync('data/backtest-trades.json', 'utf8'))
// Trades by governance protocol (from proposalId prefix or rationale)
const byGovProto = {}
for (const t of trades) {
  const r = t.rationale || ''
  // Extract protocol from rationale
  const proto = t.proposalId?.split('-')[0] || 'unknown'
  const key = proto.length > 20 ? 'onchain' : proto
  if (!byGovProto[key]) byGovProto[key] = {count:0, pnl:0, wins:0, details:[]}
  byGovProto[key].count++
  byGovProto[key].pnl += t.pnl || 0
  if ((t.pnl||0) > 0) byGovProto[key].wins++
}

// Also show by asset
const byAsset = {}
for (const t of trades) {
  const a = t.asset || 'unknown'
  if (!byAsset[a]) byAsset[a] = {count:0, pnl:0, wins:0}
  byAsset[a].count++
  byAsset[a].pnl += t.pnl || 0
  if ((t.pnl||0) > 0) byAsset[a].wins++
}
console.log('=== TRADES BY ASSET ===')
Object.entries(byAsset)
  .sort((a,b) => b[1].pnl - a[1].pnl)
  .forEach(([a,d]) => console.log(`  ${a}: ${d.count}tr WR ${(d.wins/d.count*100).toFixed(0)}% PnL $${d.pnl.toFixed(0)}`))

console.log('\n=== ALL TRADES (proposalId + asset + PnL) ===')
trades.sort((a,b) => (b.pnl||0)-(a.pnl||0)).forEach(t => {
  const id = t.proposalId?.slice(0,40) || 'n/a'
  console.log(`  ${t.asset} $${(t.pnl||0).toFixed(0)} [${id}]`)
})
