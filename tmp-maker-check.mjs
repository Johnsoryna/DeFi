import Database from 'better-sqlite3';
const db = new Database('C:/Code/DeFi/data/backtest.db');

// Check MAKER forum posts for risk-related content  
const risk = db.prepare(`
  SELECT title, created_at FROM historical_forum_posts 
  WHERE forum_url='https://forum.makerdao.com'
  AND (title LIKE '%DSR%' OR title LIKE '%DAI%' OR title LIKE '%collateral%' 
    OR title LIKE '%liquidat%' OR title LIKE '%stability fee%' OR title LIKE '%risk%'
    OR title LIKE '%DAI Savings%' OR title LIKE '%Parameter%' OR title LIKE '%cap%'
    OR title LIKE '%freeze%' OR title LIKE '%vault%' OR title LIKE '%shutdown%')
  AND created_at >= '2025-01-01'
  ORDER BY created_at DESC LIMIT 30
`).all();
console.log('=== MAKER Risk-related posts (2025+) ===');
risk.forEach(p => {
  console.log(`[${p.created_at.slice(0,10)}] ${p.title}`);
});

// Also check snapshot proposals for maker
const snaps = db.prepare(`
  SELECT space, COUNT(*) as cnt FROM historical_snapshots GROUP BY space
`).all();
console.log('\nSnapshot spaces:');
snaps.forEach(s => console.log('  ' + s.space + ': ' + s.cnt));

db.close();
