import fs from 'fs';
const trades = JSON.parse(fs.readFileSync('data/backtest-trades.json', 'utf8'));
trades.forEach(t => {
  const d = new Date(t.openedAt).toISOString().slice(0,10);
  console.log(`${d}\t${t.asset}\t${t.direction}\t${Math.round(t.pnl)}`);
});
