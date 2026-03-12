/**
 * NLP forensic analysis: correlate trades to source posts by timestamp.
 * Forum posts have title only (no body in DB).
 * Snapshots have title + body.
 */
import Database from 'better-sqlite3';
import fs from 'fs';

const db = new Database('data/backtest.db');
const trades = JSON.parse(fs.readFileSync('data/backtest-trades.json', 'utf8'));

// Protocol → forum URL map
const FORUM_URLS = {
  aave: 'https://governance.aave.com',
  compound: 'https://www.comp.xyz',
  dydx: 'https://dydx.forum',
  arbitrum: 'https://forum.arbitrum.foundation',
  lido: 'https://research.lido.fi',
  curve: 'https://gov.curve.fi',
  gmx: 'https://gov.gmx.io',
  eigenlayer: 'https://forum.eigenlayer.xyz',
  injective: 'https://gov.injective.network',
};

// Asset → protocol map
const ASSET_PROTOCOL = {
  AAVE: 'aave', COMP: 'compound', DYDX: 'dydx', ARB: 'arbitrum',
  LDO: 'lido', CRV: 'curve', GMX: 'gmx', EIGEN: 'eigenlayer',
  INJ: 'injective', WSTETH: 'lido', SNX: 'synthetix',
};

// Snapshot spaces per protocol
const SNAPSHOT_SPACES_BY_PROTOCOL = {
  aave: ['aave.eth'],
  compound: ['comp-vote.eth'],
  dydx: ['dydxgov.eth'],
  arbitrum: ['arbitrumfoundation.eth'],
  lido: ['lido-snapshot.eth'],
  gmx: ['gmx.eth'],
  ethena: ['ethenagovernance.eth'],
  eigenlayer: ['eigen.eth'],
};

console.log('=== NLP FORENSICS: Source Posts for 36 Trades ===\n');

const allSources = [];

for (const trade of trades) {
  const openMs = trade.openedAt;
  const openDate = new Date(openMs).toISOString().slice(0, 10);
  const lookbackMs = 4 * 24 * 60 * 60 * 1000;
  const startMs = openMs - lookbackMs;
  const startDate = new Date(startMs).toISOString().slice(0, 10);

  const protocol = ASSET_PROTOCOL[trade.asset];
  const pnl = Math.round(trade.pnl);

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`[${openDate}] ${trade.asset} ${trade.direction}  PnL: $${pnl}`);

  let foundPosts = [];

  // 1. Forum posts (title only)
  if (protocol && FORUM_URLS[protocol]) {
    const forumUrl = FORUM_URLS[protocol];
    const posts = db.prepare(`
      SELECT title, created_at, forum_url, topic_id
      FROM historical_forum_posts
      WHERE forum_url = ?
        AND created_at >= ? AND created_at <= ?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(forumUrl, startDate, openDate + 'T23:59:59');

    for (const p of posts) {
      foundPosts.push({ type: 'forum', date: p.created_at?.slice(0,10), title: p.title, body: null, source: p.forum_url });
    }
  }

  // 2. Snapshots
  const spaces = SNAPSHOT_SPACES_BY_PROTOCOL[protocol] || [];
  if (spaces.length > 0) {
    const placeholders = spaces.map(() => '?').join(',');
    const snaps = db.prepare(`
      SELECT title, body, start, space
      FROM historical_snapshots
      WHERE space IN (${placeholders})
        AND start >= ? AND start <= ?
      ORDER BY start DESC
      LIMIT 5
    `).all(...spaces, startMs, openMs);

    for (const s of snaps) {
      foundPosts.push({ type: 'snapshot', date: new Date(s.start).toISOString().slice(0,10), title: s.title, body: (s.body||'').slice(0,300), source: s.space });
    }
  }

  if (foundPosts.length === 0) {
    console.log(`  *** NO SOURCE FOUND in DB within 4-day window ***`);
  } else {
    for (const p of foundPosts) {
      console.log(`  [${p.type.toUpperCase()}] ${p.date} "${p.title}"`);
      if (p.body) console.log(`    Body: ${p.body.replace(/\n/g,' ')}`);
      allSources.push({ trade: `${trade.asset} ${trade.direction} $${pnl}`, openDate, ...p });
    }
  }
}

// ─── Keyword Analysis ────────────────────────────────────────────────
console.log(`\n\n${'═'.repeat(70)}`);
console.log('=== WINNING TITLE KEYWORD FREQUENCY ===\n');

const STOP_WORDS = new Set([
  'with','from','that','this','will','have','been','some','into','over','more',
  'also','aave','comp','dydx','arfc','temp','check','arb','ldo','crv','gmx',
  'update','proposal','governance','protocol','for','the','and','of','to','in',
  'on','a','an','at','by','or','its','their','which','when','all','new','add',
  'v3','v2','risk','asset','market','base','core','main','chain','pool','rate',
]);

const titleFreq = {};
const bodyFreq = {};

for (const s of allSources) {
  const words = s.title.toLowerCase().replace(/[^\w\s]/g,' ').split(/\s+/).filter(w=>w.length>=4 && !STOP_WORDS.has(w));
  for (const w of words) {
    titleFreq[w] = (titleFreq[w]||0) + 1;
  }
  if (s.body) {
    const bwords = s.body.toLowerCase().replace(/[^\w\s]/g,' ').split(/\s+/).filter(w=>w.length>=4 && !STOP_WORDS.has(w));
    for (const w of bwords) {
      bodyFreq[w] = (bodyFreq[w]||0) + 1;
    }
  }
}

const sortedTitle = Object.entries(titleFreq).sort((a,b)=>b[1]-a[1]).slice(0,50);
console.log('Top keywords in TITLES of winning-trade source posts:');
for (const [w, n] of sortedTitle) {
  console.log(`  ${String(n).padStart(3)}x  ${w}`);
}

console.log('\nTop keywords in SNAPSHOT BODIES of winning-trade sources:');
const sortedBody = Object.entries(bodyFreq).sort((a,b)=>b[1]-a[1]).slice(0,30);
for (const [w, n] of sortedBody) {
  console.log(`  ${String(n).padStart(3)}x  ${w}`);
}

// ─── NLP Classification of each winning title ───────────────────────
console.log(`\n\n${'═'.repeat(70)}`);
console.log('=== WINNING TITLES CLASSIFIED ===\n');

const BEARISH_KWORDS = ['deprecat','freeze','pause','delist','offboard','remove','reduce','decrease','lower','sunset','winding down','wind down','shutdown','shut down','cease','emergency','disable','recall'];
const RISK_KWORDS = ['supply cap','borrow cap','liquidation threshold','ltv','debt ceiling','interest rate','borrow rate','reserve factor','ir curve','collateral factor','stability fee','risk parameter'];

for (const s of allSources) {
  if (s.type !== 'forum') continue; // Mostly focus on forum titles
  const t = s.title.toLowerCase();
  const hasBearish = BEARISH_KWORDS.filter(k=>t.includes(k));
  const hasRisk = RISK_KWORDS.filter(k=>t.includes(k));
  if (hasBearish.length > 0 || hasRisk.length > 0) {
    console.log(`[${s.openDate}] ${s.trade}`);
    console.log(`  Title: "${s.title}"`);
    if (hasBearish.length>0) console.log(`  Bearish keywords: ${hasBearish.join(', ')}`);
    if (hasRisk.length>0) console.log(`  Risk keywords: ${hasRisk.join(', ')}`);
    console.log();
  }
}

console.log('\n=== UNIQUE SOURCE TITLES (forum posts driving trades) ===\n');
const seenTitles = new Set();
for (const s of allSources) {
  if (!seenTitles.has(s.title)) {
    seenTitles.add(s.title);
    console.log(`[${s.openDate}] [${s.type}] "${s.title}"`);
  }
}
