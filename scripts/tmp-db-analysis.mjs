import Database from 'better-sqlite3'
const db = new Database('data/backtest.db')
const tokens = ['SNX','PENDLE','GRT','RDNT']
for (const t of tokens) {
  const r = db.prepare('SELECT COUNT(*) as n, MIN(timestamp) as mn, MAX(timestamp) as mx FROM historical_prices WHERE asset=?').get(t)
  const mn = r.n > 0 ? new Date(r.mn).toISOString().slice(0,10) : '-'
  const mx = r.n > 0 ? new Date(r.mx).toISOString().slice(0,10) : '-'
  console.log(`${t}: ${r.n} points ${r.n>0 ? '('+mn+' to '+mx+')' : '— NOT IN DB'}`)
}
