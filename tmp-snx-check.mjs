import Database from 'better-sqlite3';
const db = new Database('C:/Code/DeFi/data/backtest.db');

// Check SNX proposals from snxgov.eth
const snxProps = db.prepare(`
  SELECT title, body, state, start, "end" 
  FROM historical_snapshots 
  WHERE space='snxgov.eth' 
  ORDER BY start DESC 
  LIMIT 20
`).all();

console.log('=== SNX (snxgov.eth) Recent Proposals ===');
snxProps.forEach(p => {
  const date = new Date(p.start * 1000).toISOString().slice(0,10);
  const preview = (p.body || '').slice(0, 150).replace(/\n/g, ' ');
  console.log(`\n[${date}] ${p.title}`);
  console.log(`  Preview: ${preview}`);
});

// Also check pendle-politics.eth if it exists
const pendleProps = db.prepare(`
  SELECT title, state, start FROM historical_snapshots 
  WHERE space='pendle-politics.eth' 
  ORDER BY start DESC LIMIT 10
`).all();
console.log('\n=== PENDLE (pendle-politics.eth) Proposals ===');
if (pendleProps.length === 0) console.log('  (no data yet)');
pendleProps.forEach(p => {
  const date = new Date(p.start * 1000).toISOString().slice(0,10);
  console.log(`[${date}] ${p.title}`);
});

db.close();
