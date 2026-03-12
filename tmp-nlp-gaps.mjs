/**
 * Find potentially-missed bearish governance posts that DON'T contain current NLP keywords
 * but show similar patterns to winning trades.
 * Also find posts with potential NEW keywords ("kill", "halt", "suspend", etc.)
 */
import Database from 'better-sqlite3';
const db = new Database('data/backtest.db');

// Current NLP bearish/risk_mitigation keywords (from nlpEngine.ts)
const CURRENT_BEARISH = [
  'deprecat', 'freeze', 'pause', 'sunset', 'wind.?down', 'winding.?down',
  'shut.?down', 'cease', 'recall', 'emergency', 'disable', 'offboard',
  'delist', 'remove', 'wind.?down', 'reduce', 'decrease', 'lower',
  'vulnerability', 'exploit', 'hack', 'breach', 'insolvency', 'bad.?debt', 'downgrade'
];

// Protocols we care about (have Binance perps)
const FORUM_URLS = [
  'https://governance.aave.com',
  'https://www.comp.xyz',
  'https://dydx.forum',
  'https://forum.arbitrum.foundation',
  'https://research.lido.fi',
  'https://gov.curve.fi',
  'https://gov.gmx.io',
  'https://forum.eigenlayer.xyz',
  'https://gov.injective.network',
  'https://forum.makerdao.com',
  'https://snxgov.discourse.group',
  'https://forum.morpho.org',
  'https://forum.thegraph.com',
  'https://forum.euler.finance',
  'https://forum.synthetix.io',
  'https://research.synthetix.io',
];

const placeholders = FORUM_URLS.map(() => '?').join(',');

// Query 1: Posts with potentially-missed bearish keywords NOT in current NLP
const POTENTIAL_KEYWORDS = [
  'kill', 'halt', 'suspend', 'terminate', 'revoke', 'cut.?off',
  'slashing', 'liquidat', 'insolv', 'exploit', 'hack', 'attack',
  'insufficient', 'shortfall', 'deficit', 'migrate.?away', 'decommission',
  'withdrawal.?only', 'borrow.?frozen', 'supply.?frozen',
  'validator.*wind', 'wind.*validator',
];

console.log('=== POTENTIALLY MISSED BEARISH KEYWORDS IN WIRED PROTOCOLS ===\n');

for (const kw of POTENTIAL_KEYWORDS) {
  const posts = db.prepare(`
    SELECT title, created_at, forum_url
    FROM historical_forum_posts
    WHERE forum_url IN (${placeholders})
      AND title LIKE '%' || ? || '%'
      AND created_at >= '2025-01-01'
    ORDER BY created_at DESC
    LIMIT 5
  `).all(...FORUM_URLS, kw.replace(/\.\?/g, '_'));

  if (posts.length > 0) {
    console.log(`\nKeyword pattern: "${kw}" → ${posts.length} posts`);
    for (const p of posts) {
      console.log(`  [${p.created_at?.slice(0,10)}] ${p.forum_url.split('/')[2]} | "${p.title}"`);
    }
  }
}

// Query 2: Check exact "kill" in title
console.log('\n\n=== EXACT "KILL" POSTS ===');
const killPosts = db.prepare(`
  SELECT title, created_at, forum_url FROM historical_forum_posts
  WHERE (title LIKE '%kill %' OR title LIKE '%Kill %' OR title LIKE '%KILL %')
    AND forum_url IN (${placeholders})
    AND created_at >= '2025-01-01'
`).all(...FORUM_URLS);
for (const p of killPosts) {
  console.log(`  [${p.created_at?.slice(0,10)}] ${p.forum_url.split('/')[2]} | "${p.title}"`);
}

// Query 3: Check AAVE posts from 2025 that generated signals in the backtest
// Look for title patterns that appear near winning AAVE trades
console.log('\n\n=== ALL BEARISH AAVE FORUM TITLES 2025 ===');
const bearishAave = db.prepare(`
  SELECT title, created_at FROM historical_forum_posts
  WHERE forum_url = 'https://governance.aave.com'
    AND created_at >= '2025-01-01'
    AND (
      title LIKE '%deprecat%' OR title LIKE '%Deprecat%'
      OR title LIKE '%disable%' OR title LIKE '%Disable%'
      OR title LIKE '%freeze%' OR title LIKE '%Freeze%'
      OR title LIKE '%pause%' OR title LIKE '%Pause%'
      OR title LIKE '%wind down%' OR title LIKE '%sunset%' OR title LIKE '%Sunset%'
      OR title LIKE '%offboard%' OR title LIKE '%Offboard%'
      OR title LIKE '%shutdown%' OR title LIKE '%shut down%'
      OR title LIKE '%emergency%' OR title LIKE '%Emergency%'
    )
  ORDER BY created_at
`).all();
console.log(`Total AAVE bearish posts: ${bearishAave.length}`);
for (const p of bearishAave) {
  console.log(`  [${p.created_at?.slice(0,10)}] "${p.title}"`);
}

// Query 4: Check snapshot proposals for bearish patterns
console.log('\n\n=== SNAPSHOT PROPOSALS WITH BEARISH KEYWORDS (all spaces, 2025) ===');
const bearishSnaps = db.prepare(`
  SELECT title, space, start FROM historical_snapshots
  WHERE (
    title LIKE '%deprecat%' OR title LIKE '%Deprecat%'
    OR title LIKE '%sunset%' OR title LIKE '%Sunset%'
    OR title LIKE '%wind down%' OR title LIKE '%Wind down%'
    OR title LIKE '%shutdown%' OR title LIKE '%shut down%'
    OR title LIKE '%emergency%' OR title LIKE '%Emergency%'
    OR title LIKE '%cease%' OR title LIKE '%Cease%'
    OR title LIKE '%kill%' OR title LIKE '%Kill%'
    OR title LIKE '%terminate%' OR title LIKE '%suspend%'
  )
  AND start >= 1735689600000
  ORDER BY start
`).all();
console.log(`Total bearish snapshots: ${bearishSnaps.length}`);
for (const s of bearishSnaps) {
  const d = new Date(s.start).toISOString().slice(0,10);
  console.log(`  [${d}] [${s.space}] "${s.title}"`);
}

// Query 5: Count total bearish posts per protocol (already captured vs potentially new)
console.log('\n\n=== BEARISH POST COUNT BY FORUM (2025) ===');
const bearishByForum = db.prepare(`
  SELECT forum_url, COUNT(*) as cnt
  FROM historical_forum_posts
  WHERE created_at >= '2025-01-01'
    AND (
      title LIKE '%deprecat%' OR title LIKE '%Deprecat%'
      OR title LIKE '%disable%' OR title LIKE '%Disable%'
      OR title LIKE '%freeze%' OR title LIKE '%Freeze%'
      OR title LIKE '%wind down%' OR title LIKE '%sunset%'
      OR title LIKE '%emergency%' OR title LIKE '%cease%'
      OR title LIKE '%recall%' OR title LIKE '%offboard%'
      OR title LIKE '%shutdown%' OR title LIKE '%shut down%'
    )
  GROUP BY forum_url
  ORDER BY cnt DESC
`).all();
for (const r of bearishByForum) {
  const url = r.forum_url.replace('https://','').split('/')[0];
  console.log(`  ${String(r.cnt).padStart(4)}  ${url}`);
}
