import Database from 'better-sqlite3';
const db = new Database('C:/Code/DeFi/data/backtest.db');

// Check GRT forum posts
const posts = db.prepare(`
  SELECT title, created_at 
  FROM historical_forum_posts 
  WHERE forum_url='https://forum.thegraph.com'
  ORDER BY created_at DESC 
  LIMIT 20
`).all();

console.log('=== The Graph Forum Posts (recent) ===');
posts.forEach(p => {
  console.log(`[${p.created_at.slice(0,10)}] ${p.title}`);
});

// Look for risk-related posts
const risk = db.prepare(`
  SELECT title FROM historical_forum_posts 
  WHERE forum_url='https://forum.thegraph.com'
  AND (title LIKE '%slash%' OR title LIKE '%risk%' OR title LIKE '%slash%' 
    OR title LIKE '%deprecat%' OR title LIKE '%freeze%' OR title LIKE '%reward%'
    OR title LIKE '%indexer%' OR title LIKE '%GIP%' OR title LIKE '%fee%')
  ORDER BY created_at DESC LIMIT 20
`).all();
console.log('\n=== Risk-related posts ===');
risk.forEach(p => console.log('  ' + p.title));

db.close();
