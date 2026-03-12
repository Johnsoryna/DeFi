import Database from 'better-sqlite3';
const db = new Database('C:/Code/DeFi/data/backtest.db');

// Forum URLs
const forums = db.prepare("SELECT forum_url, COUNT(*) as cnt FROM historical_forum_posts GROUP BY forum_url ORDER BY cnt DESC").all();
console.log('Forum posts by URL:');
forums.forEach(f => console.log('  ' + f.forum_url + ': ' + f.cnt));

// Snapshots by space
const snaps = db.prepare("SELECT space, COUNT(*) as cnt FROM historical_snapshots GROUP BY space ORDER BY cnt DESC").all();
console.log('\nSnapshots by space:');
snaps.forEach(s => console.log('  ' + s.space + ': ' + s.cnt));

// Check for new SNX/PENDLE/GRT data
const snxForum = db.prepare("SELECT COUNT(*) as cnt FROM historical_forum_posts WHERE forum_url LIKE '%synthetix%'").get();
const pendleForum = db.prepare("SELECT COUNT(*) as cnt FROM historical_forum_posts WHERE forum_url LIKE '%pendle%'").get();
const grtForum = db.prepare("SELECT COUNT(*) as cnt FROM historical_forum_posts WHERE forum_url LIKE '%graph%' OR forum_url LIKE '%thegraph%'").get();

// Prices
const pendlePrice = db.prepare("SELECT COUNT(*) as cnt FROM historical_prices WHERE asset='PENDLE'").get();
const grtPrice = db.prepare("SELECT COUNT(*) as cnt FROM historical_prices WHERE asset='GRT'").get();
const snxPrice = db.prepare("SELECT COUNT(*) as cnt FROM historical_prices WHERE asset='SNX'").get();

console.log('\nSNX forum posts (research.synthetix.io):', snxForum.cnt);
console.log('PENDLE forum posts:', pendleForum.cnt);
console.log('GRT forum posts:', grtForum.cnt);
console.log('\nPrices: PENDLE=' + pendlePrice.cnt + ', GRT=' + grtPrice.cnt + ', SNX=' + snxPrice.cnt);

db.close();
