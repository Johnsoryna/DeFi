/**
 * Keyword Mining: Find posts from wired protocols where the token price
 * DROPPED significantly after the post, but we DID NOT trade.
 * Extract keywords from those "missed opportunity" posts that are NOT
 * currently in the NLP engine.
 */
import Database from 'better-sqlite3';
import fs from 'fs';

const db = new Database('data/backtest.db');
const trades = JSON.parse(fs.readFileSync('data/backtest-trades.json', 'utf8'));

// Protocol → token mapping (wired protocols with Binance perps)
const PROTOCOL_TOKEN = {
  'https://governance.aave.com': 'AAVE',
  'https://www.comp.xyz': 'COMP',
  'https://dydx.forum': 'DYDX',
  'https://forum.arbitrum.foundation': 'ARB',
  'https://research.lido.fi': 'LDO',
  'https://gov.curve.fi': 'CRV',
  'https://gov.gmx.io': 'GMX',
  'https://forum.eigenlayer.xyz': 'EIGEN',
  'https://gov.injective.network': 'INJ',
  'https://forum.makerdao.com': 'MKR',
  'https://snxgov.discourse.group': 'SNX',
  'https://forum.morpho.org': 'MORPHO',
  'https://forum.thegraph.com': 'GRT',
  'https://forum.euler.finance': 'EUL',
  'https://forum.synthetix.io': 'SNX',
  'https://research.synthetix.io': 'SNX',
};

const SPACE_TOKEN = {
  'aavedao.eth': 'AAVE',
  'compound-governance.eth': 'COMP',
  'dydxgov.eth': 'DYDX',
  'arbitrumfoundation.eth': 'ARB',
  'lido-snapshot.eth': 'LDO',
  'gmx.eth': 'GMX',
  'ethenagovernance.eth': 'ENA',
  'morpho.eth': 'MORPHO',
  'eulerdao.eth': 'EUL',
  'snxgov.eth': 'SNX',
  'cvx.eth': 'CVX',
  'veyfi.eth': 'YFI',
  'aave.eth': 'AAVE',
  'comp-vote.eth': 'COMP',
  'gmx.eth': 'GMX',
  'eigen.eth': 'EIGEN',
};

// Current NLP keywords (risk_mitigation + bearish patterns) — everything already in the engine
const CURRENT_NLP_KEYWORDS = new Set([
  'deprecat', 'freeze', 'pause', 'sunset', 'wind down', 'winding down',
  'shut down', 'shutdown', 'cease', 'recall', 'emergency', 'disable',
  'offboard', 'delist', 'remove', 'reduce', 'decrease', 'lower',
  'vulnerability', 'exploit', 'hack', 'breach', 'insolvency', 'bad debt',
  'downgrade', 'supply cap', 'borrow cap', 'liquidation', 'ltv',
  'collateral factor', 'stability fee', 'reserve factor', 'interest rate',
  'ir curve', 'debt ceiling', 'slash', 'cut', 'phase out', 'wind',
  'phaseout', 'wind-down', 'risk', 'security', 'critical', 'urgent',
  'migration', 'migrate', 'decommission', 'retire', 'offboard',
  'pause', 'halt', 'freeze', 'block', 'restrict',
]);

// Stop words — ignore these
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his',
  'how', 'its', 'new', 'now', 'old', 'see', 'two', 'who', 'did', 'with',
  'from', 'that', 'this', 'will', 'have', 'been', 'some', 'into', 'over',
  'more', 'also', 'than', 'then', 'when', 'would', 'there', 'their',
  'what', 'which', 'they', 'about', 'could', 'other', 'after', 'first',
  'these', 'those', 'only', 'very', 'just', 'into', 'well', 'each',
  'should', 'through', 'before', 'where', 'while', 'being',
  // DeFi/governance noise words
  'aave', 'comp', 'dydx', 'arfc', 'temp', 'check', 'arb', 'ldo', 'crv',
  'update', 'proposal', 'governance', 'protocol', 'v3', 'v2', 'base',
  'core', 'main', 'chain', 'pool', 'rate', 'market', 'asset', 'token',
  'vote', 'voting', 'snapshot', 'forum', 'community', 'dao', 'grant',
  'funding', 'treasury', 'budget', 'team', 'working', 'group',
  'report', 'quarter', 'monthly', 'weekly', 'annual', 'period',
  'request', 'temp', 'check', 'discussion', 'feedback', 'review',
  'implementation', 'deploy', 'deployment', 'launch', 'release',
  'version', 'upgrade', 'network', 'contract', 'smart', 'ethereum',
  'solana', 'layer', 'cross', 'multi', 'integration', 'support',
  'enable', 'add', 'listing', 'onboard', 'parameter', 'params',
  'increase', 'adjust', 'change', 'update', 'modify', 'set',
  'user', 'users', 'developer', 'program', 'incentive', 'reward',
  'epoch', 'season', 'round', 'cycle', 'phase', 'stage', 'step',
  'delegate', 'delegation', 'snapshot', 'tally', 'quorum', 'threshold',
  'vote', 'votes', 'voter', 'voters', 'proposal', 'proposals',
  'gauge', 'weight', 'emission', 'boost', 'lock', 'stake', 'staking',
  'liquidity', 'depth', 'volume', 'tvl', 'fee', 'fees', 'revenue',
  'yield', 'apy', 'apr', 'return', 'profit', 'loss', 'position',
  'long', 'short', 'leverage', 'margin', 'collateral', 'borrow',
  'lend', 'supply', 'deposit', 'withdraw', 'transfer', 'bridge',
  'swap', 'trade', 'exchange', 'price', 'oracle', 'feed', 'data',
  'address', 'wallet', 'multisig', 'safe', 'admin', 'owner', 'role',
  'permission', 'access', 'control', 'whitelist', 'blacklist',
  'limit', 'cap', 'floor', 'ceiling', 'bound', 'range', 'level',
  'ratio', 'factor', 'multiplier', 'scale', 'model', 'curve', 'slope',
  'current', 'existing', 'proposed', 'new', 'old', 'initial', 'final',
  'approved', 'rejected', 'passed', 'failed', 'active', 'inactive',
  'open', 'closed', 'pending', 'completed', 'cancelled',
  'eth', 'btc', 'usd', 'usdc', 'usdt', 'dai', 'weth', 'wbtc',
  'with', 'from', 'that', 'this', 'will', 'have', 'been', 'some',
  'into', 'over', 'more', 'also', 'aave', 'comp', 'arfc', 'arb',
  'ldo', 'crv', 'gmx', 'dydx', 'eigen', 'inj', 'snx', 'grt', 'eul',
  'morpho', 'maker', 'curve', 'lido', 'arbitrum', 'compound',
]);

// Get price for an asset at a specific timestamp (nearest available)
function getPrice(asset, tsMs) {
  const row = db.prepare(
    'SELECT price FROM historical_prices WHERE asset = ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT 1'
  ).get(asset, tsMs);
  return row ? parseFloat(row.price) : null;
}

// Get price N days after a timestamp
function getPriceAfter(asset, tsMs, days) {
  const afterMs = tsMs + days * 24 * 3600 * 1000;
  return getPrice(asset, afterMs);
}

// Check if we traded near this date (within 3 days)
function tradedNear(asset, tsMs) {
  const windowMs = 3 * 24 * 3600 * 1000;
  return trades.some(t =>
    t.asset === asset &&
    Math.abs(t.openedAt - tsMs) < windowMs
  );
}

// Extract meaningful words from a title
function extractWords(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w));
}

// Check if a word is already covered by NLP (partial match)
function isCoveredByNLP(word) {
  for (const kw of CURRENT_NLP_KEYWORDS) {
    if (word.includes(kw) || kw.includes(word)) return true;
  }
  return false;
}

const MIN_DROP_PCT = 5; // minimum price drop % to consider "missed opportunity"
const LOOK_AHEAD_DAYS = 14; // how many days after post to check price

console.log('=== KEYWORD MINING: Missed Profitable Signals ===\n');
console.log(`Looking for posts where token dropped >${MIN_DROP_PCT}% in ${LOOK_AHEAD_DAYS} days\n`);

const missedPosts = [];

// ── Forum Posts ──────────────────────────────────────────────────────────────
console.log('Analyzing forum posts...');
const forumPosts = db.prepare(`
  SELECT title, created_at, forum_url
  FROM historical_forum_posts
  WHERE created_at >= '2025-01-01'
    AND forum_url IN (${Object.keys(PROTOCOL_TOKEN).map(() => '?').join(',')})
  ORDER BY created_at
`).all(...Object.keys(PROTOCOL_TOKEN));

console.log(`Total forum posts to analyze: ${forumPosts.length}`);

for (const post of forumPosts) {
  const asset = PROTOCOL_TOKEN[post.forum_url];
  if (!asset) continue;

  const tsMs = new Date(post.created_at).getTime();
  if (!tsMs || isNaN(tsMs)) continue;

  const priceAt = getPrice(asset, tsMs);
  const priceAfter = getPriceAfter(asset, tsMs, LOOK_AHEAD_DAYS);

  if (!priceAt || !priceAfter || priceAt === 0) continue;

  const dropPct = ((priceAfter - priceAt) / priceAt) * 100;

  if (dropPct < -MIN_DROP_PCT) {
    const alreadyTraded = tradedNear(asset, tsMs);
    missedPosts.push({
      type: 'forum',
      title: post.title,
      asset,
      date: post.created_at.slice(0, 10),
      tsMs,
      dropPct: dropPct.toFixed(1),
      priceAt: priceAt.toFixed(2),
      priceAfter: priceAfter.toFixed(2),
      alreadyTraded,
    });
  }
}

// ── Snapshots ─────────────────────────────────────────────────────────────────
console.log('Analyzing snapshots...');
const snapshots = db.prepare(`
  SELECT title, body, start, space
  FROM historical_snapshots
  WHERE start >= 1735689600000
    AND space IN (${Object.keys(SPACE_TOKEN).map(() => '?').join(',')})
  ORDER BY start
`).all(...Object.keys(SPACE_TOKEN));

console.log(`Total snapshots to analyze: ${snapshots.length}`);

for (const snap of snapshots) {
  const asset = SPACE_TOKEN[snap.space];
  if (!asset) continue;

  const tsMs = snap.start;
  const priceAt = getPrice(asset, tsMs);
  const priceAfter = getPriceAfter(asset, tsMs, LOOK_AHEAD_DAYS);

  if (!priceAt || !priceAfter || priceAt === 0) continue;

  const dropPct = ((priceAfter - priceAt) / priceAt) * 100;

  if (dropPct < -MIN_DROP_PCT) {
    const alreadyTraded = tradedNear(asset, tsMs);
    missedPosts.push({
      type: 'snapshot',
      title: snap.title,
      body: (snap.body || '').slice(0, 500),
      asset,
      date: new Date(tsMs).toISOString().slice(0, 10),
      tsMs,
      dropPct: dropPct.toFixed(1),
      priceAt: priceAt.toFixed(2),
      priceAfter: priceAfter.toFixed(2),
      alreadyTraded,
    });
  }
}

console.log(`\nTotal posts where token dropped >${MIN_DROP_PCT}% in ${LOOK_AHEAD_DAYS}d: ${missedPosts.length}`);
const missed = missedPosts.filter(p => !p.alreadyTraded);
const covered = missedPosts.filter(p => p.alreadyTraded);
console.log(`Already traded: ${covered.length}`);
console.log(`NOT traded (missed): ${missed.length}`);

// ── Keyword Extraction from MISSED posts ──────────────────────────────────────
console.log('\n=== MISSED POSTS — NOT TRADED ===\n');

const wordFreq = {}; // word → {count, totalDrop, posts}
const newWordFreq = {}; // only words NOT in current NLP

for (const post of missed) {
  const words = extractWords(post.title);
  // Also extract from snapshot body
  const bodyWords = post.body ? extractWords(post.body) : [];
  const allWords = [...new Set([...words, ...bodyWords.slice(0, 50)])];

  for (const word of allWords) {
    if (!wordFreq[word]) wordFreq[word] = { count: 0, totalDrop: 0, posts: [] };
    wordFreq[word].count++;
    wordFreq[word].totalDrop += Math.abs(parseFloat(post.dropPct));
    wordFreq[word].posts.push(post.title.slice(0, 60));

    if (!isCoveredByNLP(word)) {
      if (!newWordFreq[word]) newWordFreq[word] = { count: 0, totalDrop: 0, posts: [] };
      newWordFreq[word].count++;
      newWordFreq[word].totalDrop += Math.abs(parseFloat(post.dropPct));
      newWordFreq[word].posts.push(post.title.slice(0, 60));
    }
  }
}

// Show missed posts with biggest drops
console.log('--- Top 30 Missed Posts (biggest price drops) ---');
missed
  .sort((a, b) => parseFloat(a.dropPct) - parseFloat(b.dropPct))
  .slice(0, 30)
  .forEach(p => {
    console.log(`[${p.date}] ${p.asset} ${p.dropPct}% | [${p.type}] "${p.title.slice(0, 80)}"`);
  });

// Show new keyword candidates (NOT in NLP, freq >= 2)
console.log('\n\n=== NEW KEYWORD CANDIDATES (not in NLP, freq >= 2) ===\n');
const candidates = Object.entries(newWordFreq)
  .filter(([, v]) => v.count >= 2)
  .sort((a, b) => (b[1].count * b[1].totalDrop) - (a[1].count * a[1].totalDrop));

console.log(`Total unique new words (freq>=2): ${candidates.length}\n`);
for (const [word, data] of candidates.slice(0, 60)) {
  const avgDrop = (data.totalDrop / data.count).toFixed(1);
  console.log(`  ${String(data.count).padStart(3)}x  avg_drop=${avgDrop}%  "${word}"`);
  // Show first 2 example posts
  const uniquePosts = [...new Set(data.posts)].slice(0, 2);
  uniquePosts.forEach(p => console.log(`    → "${p}"`));
}

// Show ALL words with freq>=2 (including NLP-covered ones) for reference
console.log('\n\n=== ALL WORDS IN MISSED POSTS (freq >= 3, for reference) ===\n');
Object.entries(wordFreq)
  .filter(([, v]) => v.count >= 3)
  .sort((a, b) => b[1].count - a[1].count)
  .slice(0, 50)
  .forEach(([word, data]) => {
    const covered = isCoveredByNLP(word) ? '✓NLP' : '❌NEW';
    const avgDrop = (data.totalDrop / data.count).toFixed(1);
    console.log(`  ${covered} ${String(data.count).padStart(3)}x  avg_drop=${avgDrop}%  "${word}"`);
  });
