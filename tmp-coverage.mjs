import Database from 'better-sqlite3';
const db = new Database('data/backtest.db');

const prices = db.prepare(`
  SELECT asset, MIN(timestamp) as oldest, MAX(timestamp) as newest, COUNT(*) as cnt
  FROM historical_prices
  WHERE asset IN ('AAVE','DYDX','ARB','CRV','COMP','LDO','SNX','ETH')
  GROUP BY asset
`).all();

console.log('=== Price Data Coverage ===');
for (const p of prices) {
  const oldest = new Date(parseInt(p.oldest)).toISOString().slice(0,10);
  const newest = new Date(parseInt(p.newest)).toISOString().slice(0,10);
  console.log(`${p.asset.padEnd(6)}: ${oldest} → ${newest} (${p.cnt} pts)`);
}

const forums = db.prepare(`
  SELECT forum_url, MIN(created_at) as oldest, MAX(created_at) as newest, COUNT(*) as cnt
  FROM historical_forum_posts
  WHERE forum_url IN (
    'https://governance.aave.com',
    'https://dydx.forum',
    'https://forum.arbitrum.foundation',
    'https://www.comp.xyz',
    'https://gov.curve.fi',
    'https://research.lido.fi'
  )
  GROUP BY forum_url
`).all();

console.log('\n=== Forum Post Coverage ===');
for (const f of forums) {
  const url = f.forum_url.replace('https://','').split('/')[0];
  console.log(`${url.padEnd(36)}: ${f.oldest.slice(0,10)} → ${f.newest.slice(0,10)} (${f.cnt} posts)`);
}

// How many posts exist BEFORE Jan 2025?
const pre2025 = db.prepare(`
  SELECT forum_url, COUNT(*) as cnt
  FROM historical_forum_posts
  WHERE created_at < '2025-01-01'
    AND forum_url IN (
      'https://governance.aave.com',
      'https://dydx.forum',
      'https://forum.arbitrum.foundation',
      'https://www.comp.xyz',
      'https://gov.curve.fi'
    )
  GROUP BY forum_url ORDER BY cnt DESC
`).all();
console.log('\n=== Forum Posts BEFORE 2025 (currently unused) ===');
for (const f of pre2025) {
  console.log(`  ${f.cnt.toString().padStart(4)} ${f.forum_url}`);
}
