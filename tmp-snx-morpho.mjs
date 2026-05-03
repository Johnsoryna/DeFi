import Database from 'better-sqlite3';
const db = new Database('data/backtest.db');

console.log('=== SNX Snapshot Proposals ===');
const snx = db.prepare(`SELECT title, body, start FROM historical_snapshots
  WHERE space = 'snxgov.eth' AND start >= 1735689600000 ORDER BY start`).all();
snx.forEach(p => {
  const d = new Date(p.start).toISOString().slice(0,10);
  const body = (p.body || '').slice(0,200).replace(/\n/g,' ');
  console.log(`[${d}] ${p.title}`);
  console.log(`  >> ${body}`);
});

console.log('\n=== MORPHO Snapshot Proposals ===');
const morpho = db.prepare(`SELECT title, body, start FROM historical_snapshots
  WHERE space = 'morpho.eth' AND start >= 1735689600000 ORDER BY start`).all();
morpho.forEach(p => {
  const d = new Date(p.start).toISOString().slice(0,10);
  const body = (p.body || '').slice(0,200).replace(/\n/g,' ');
  console.log(`[${d}] ${p.title}`);
  console.log(`  >> ${body}`);
});

console.log('\n=== Euler Snapshot Proposals ===');
const euler = db.prepare(`SELECT title, body, start FROM historical_snapshots
  WHERE space = 'eulerdao.eth' ORDER BY start`).all();
euler.forEach(p => {
  const d = new Date(p.start).toISOString().slice(0,10);
  const body = (p.body || '').slice(0,200).replace(/\n/g,' ');
  console.log(`[${d}] ${p.title}`);
  console.log(`  >> ${body}`);
});
