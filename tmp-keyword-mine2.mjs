/**
 * Keyword Mining v2 — Smarter filtering:
 * 1. Short window: 7 days
 * 2. Idiosyncratic: token drops MORE than ETH in same window (not macro)
 * 3. NLP blind: title contains NONE of the current NLP keywords
 * 4. Min 8% drop after NLP-blind posts
 *
 * These are GENUINE missed opportunities due to missing NLP coverage.
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
  'aave.eth': 'AAVE',
  'comp-vote.eth': 'COMP',
  'eigen.eth': 'EIGEN',
};

// ALL current NLP keywords (risk_mitigation + bearish patterns from nlpEngine.ts)
// If ANY of these appear in a post title, the NLP already sees it → not a genuine gap
const NLP_KEYWORD_REGEXES = [
  /deprecat/i, /freeze/i, /pause/i, /sunset/i, /wind.?down/i, /winding.?down/i,
  /shut.?down/i, /shutdown/i, /cease/i, /recall/i, /emergency/i, /disable/i,
  /offboard/i, /delist/i, /\bremove\b/i, /\breduce\b/i, /\bdecrease\b/i, /\blower\b/i,
  /vulnerability/i, /exploit/i, /\bhack\b/i, /breach/i, /insolvency/i, /bad.?debt/i,
  /downgrade/i, /\bslash/i, /\bcut\b/i, /phase.?out/i, /wind-?down/i,
  /supply.?cap/i, /borrow.?cap/i, /liquidation.?threshold/i, /\bltv\b/i,
  /collateral.?factor/i, /stability.?fee/i, /reserve.?factor/i, /interest.?rate/i,
  /ir.?curve/i, /debt.?ceiling/i, /risk.?parameter/i,
  /terminate/i, /revoke/i, /suspend/i, /decommission/i, /retire\b/i,
  /\bhalt\b/i, /\bkill\b/i, /\bblock\b/i, /restrict/i,
];

function isNLPBlind(title) {
  return !NLP_KEYWORD_REGEXES.some(re => re.test(title));
}

// Get price for an asset at a specific timestamp
function getPrice(asset, tsMs) {
  const row = db.prepare(
    'SELECT price FROM historical_prices WHERE asset = ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT 1'
  ).get(asset, tsMs);
  return row ? parseFloat(row.price) : null;
}

function getPriceAfter(asset, tsMs, days) {
  const afterMs = tsMs + days * 24 * 3600 * 1000;
  return getPrice(asset, afterMs);
}

function priceDrop(asset, tsMs, days) {
  const p0 = getPrice(asset, tsMs);
  const p1 = getPriceAfter(asset, tsMs, days);
  if (!p0 || !p1 || p0 === 0) return null;
  return ((p1 - p0) / p0) * 100;
}

function tradedNear(asset, tsMs, windowDays = 3) {
  const windowMs = windowDays * 24 * 3600 * 1000;
  return trades.some(t => t.asset === asset && Math.abs(t.openedAt - tsMs) < windowMs);
}

const STOP_WORDS = new Set([
  'the','and','for','are','but','not','you','all','can','had','her','was','one',
  'our','out','day','get','has','him','his','how','its','new','now','old','see',
  'two','who','did','with','from','that','this','will','have','been','some','into',
  'over','more','also','than','then','when','would','there','their','what','which',
  'they','about','could','other','after','first','these','those','only','very',
  'just','well','each','should','through','before','where','while','being',
  'aave','comp','dydx','arfc','temp','check','arb','ldo','crv','gmx','inj',
  'update','proposal','governance','protocol','v3','v2','base','core','main',
  'chain','pool','rate','market','asset','token','vote','voting','snapshot',
  'forum','community','dao','grant','funding','treasury','budget','team',
  'request','discussion','feedback','review','implementation','deploy','launch',
  'release','version','upgrade','network','contract','smart','ethereum',
  'layer','integration','support','enable','listing','onboard','params',
  'increase','adjust','change','modify','user','users','developer','program',
  'incentive','reward','epoch','season','round','cycle','phase','stage','step',
  'delegate','delegation','quorum','threshold','gauge','weight','emission',
  'boost','lock','stake','staking','liquidity','depth','volume','tvl','fee',
  'fees','revenue','yield','apy','apr','return','profit','loss','position',
  'long','short','leverage','margin','collateral','borrow','lend','supply',
  'deposit','withdraw','transfer','bridge','swap','trade','exchange','price',
  'oracle','feed','data','address','wallet','multisig','safe','admin','owner',
  'role','permission','access','control','whitelist','limit','floor','ceiling',
  'bound','range','level','ratio','factor','multiplier','scale','model','slope',
  'current','existing','proposed','initial','final','approved','rejected',
  'passed','failed','active','inactive','open','closed','pending','completed',
  'eth','btc','usd','usdc','usdt','dai','weth','wbtc','snx','grt','eul',
  'morpho','maker','curve','lido','arbitrum','compound','eigenlayer',
  'month','week','year','quarter','annual','january','february','march','april',
  'may','june','july','august','september','october','november','december',
  'report','summary','meeting','council','foundation','labs','protocol',
  'direct','instance','stewards','chaos','gauntlet','recommendations',
  'spark','upcoming','spell','following','information','decision','favor',
  'official','author','motivation','parameters','changes','markets','assets',
  'tokens','pools','incentives','rewards','gauges','stableswap','crvusd',
  'llamalend','sonic','frxusd','sccp','sips','synthetix','september',
  'october','november','december','january','february','march',
]);

function extractWords(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z\s\-]/g, ' ')
    .replace(/-/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w));
}

const WINDOW_DAYS = 7;
const MIN_DROP = 8; // % token drop
const ETH_EXCESS = 3; // token must drop at least X% MORE than ETH

console.log('=== KEYWORD MINING v2 — Genuine NLP Gaps ===');
console.log(`Filter: token drop >${MIN_DROP}% in ${WINDOW_DAYS}d, idiosyncratic (>${ETH_EXCESS}% more than ETH), NLP-blind title\n`);

const genuineMisses = [];

// ── Forum Posts ───────────────────────────────────────────────────────────────
const forumPosts = db.prepare(`
  SELECT title, created_at, forum_url
  FROM historical_forum_posts
  WHERE created_at >= '2025-01-01'
    AND forum_url IN (${Object.keys(PROTOCOL_TOKEN).map(() => '?').join(',')})
  ORDER BY created_at
`).all(...Object.keys(PROTOCOL_TOKEN));

for (const post of forumPosts) {
  if (!isNLPBlind(post.title)) continue; // skip posts the NLP already covers

  const asset = PROTOCOL_TOKEN[post.forum_url];
  const tsMs = new Date(post.created_at).getTime();
  if (isNaN(tsMs)) continue;

  const tokenDrop = priceDrop(asset, tsMs, WINDOW_DAYS);
  const ethDrop = priceDrop('WETH', tsMs, WINDOW_DAYS);
  if (tokenDrop === null) continue;

  // Idiosyncratic: token drops significantly more than ETH
  const excess = tokenDrop - (ethDrop || 0);

  if (tokenDrop < -MIN_DROP && excess < -ETH_EXCESS) {
    genuineMisses.push({
      type: 'forum',
      title: post.title,
      asset,
      date: post.created_at.slice(0, 10),
      tsMs,
      tokenDrop: tokenDrop.toFixed(1),
      ethDrop: (ethDrop || 0).toFixed(1),
      excess: excess.toFixed(1),
      alreadyTraded: tradedNear(asset, tsMs),
    });
  }
}

// ── Snapshots ─────────────────────────────────────────────────────────────────
const snapshots = db.prepare(`
  SELECT title, body, start, space
  FROM historical_snapshots
  WHERE start >= 1735689600000
    AND space IN (${Object.keys(SPACE_TOKEN).map(() => '?').join(',')})
  ORDER BY start
`).all(...Object.keys(SPACE_TOKEN));

for (const snap of snapshots) {
  if (!isNLPBlind(snap.title)) continue;

  const asset = SPACE_TOKEN[snap.space];
  const tsMs = snap.start;

  const tokenDrop = priceDrop(asset, tsMs, WINDOW_DAYS);
  const ethDrop = priceDrop('WETH', tsMs, WINDOW_DAYS);
  if (tokenDrop === null) continue;

  const excess = tokenDrop - (ethDrop || 0);

  if (tokenDrop < -MIN_DROP && excess < -ETH_EXCESS) {
    genuineMisses.push({
      type: 'snapshot',
      title: snap.title,
      body: (snap.body || '').slice(0, 300),
      asset,
      date: new Date(tsMs).toISOString().slice(0, 10),
      tsMs,
      tokenDrop: tokenDrop.toFixed(1),
      ethDrop: (ethDrop || 0).toFixed(1),
      excess: excess.toFixed(1),
      alreadyTraded: tradedNear(asset, tsMs),
    });
  }
}

const missed = genuineMisses.filter(p => !p.alreadyTraded);
const covered = genuineMisses.filter(p => p.alreadyTraded);

console.log(`Total NLP-blind posts with idiosyncratic drop: ${genuineMisses.length}`);
console.log(`Already traded nearby: ${covered.length}`);
console.log(`TRUE MISSED (NLP blind + not traded): ${missed.length}\n`);

// Sort by excess drop
missed.sort((a, b) => parseFloat(a.excess) - parseFloat(b.excess));

console.log('=== TRUE MISSED OPPORTUNITIES ===');
console.log('(NLP had no keywords → no signal generated, but token dropped significantly)\n');

for (const p of missed) {
  console.log(`[${p.date}] ${p.asset.padEnd(8)} ${p.type.padEnd(9)} token:${p.tokenDrop}%  ETH:${p.ethDrop}%  excess:${p.excess}%`);
  console.log(`  "${p.title}"`);
  if (p.body) console.log(`  Body: ${p.body.replace(/\n/g,' ').slice(0,100)}`);
}

// ── Extract candidate keywords from missed posts ──────────────────────────────
console.log('\n\n=== CANDIDATE KEYWORDS FROM MISSED POSTS ===\n');
console.log('(Words that appear in posts we missed, NOT covered by current NLP)\n');

const wordData = {}; // word → {count, totalExcess, examples}

for (const p of missed) {
  const words = [...new Set(extractWords(p.title))];
  const bodyWords = p.body ? [...new Set(extractWords(p.body))].slice(0, 30) : [];
  const allWords = [...new Set([...words, ...bodyWords])];

  for (const word of allWords) {
    if (!wordData[word]) wordData[word] = { count: 0, totalExcess: 0, examples: [] };
    wordData[word].count++;
    wordData[word].totalExcess += Math.abs(parseFloat(p.excess));
    if (wordData[word].examples.length < 3) {
      wordData[word].examples.push(`[${p.asset}] "${p.title.slice(0, 70)}"`);
    }
  }
}

const candidates = Object.entries(wordData)
  .filter(([, v]) => v.count >= 2)
  .sort((a, b) => {
    // Score = frequency × avg excess drop
    const scoreA = a[1].count * (a[1].totalExcess / a[1].count);
    const scoreB = b[1].count * (b[1].totalExcess / b[1].count);
    return scoreB - scoreA;
  });

console.log(`Keywords appearing in ≥2 missed posts:\n`);
for (const [word, data] of candidates) {
  const avgExcess = (data.totalExcess / data.count).toFixed(1);
  console.log(`  ${String(data.count).padStart(3)}x  avg_excess=${avgExcess}%  "${word}"`);
  for (const ex of data.examples) console.log(`    → ${ex}`);
}

// ── Also show covered posts (already traded, confirm correlation) ──────────────
console.log('\n\n=== ALREADY TRADED (confirms approach works) ===\n');
covered.sort((a, b) => parseFloat(a.excess) - parseFloat(b.excess));
for (const p of covered.slice(0, 10)) {
  console.log(`[${p.date}] ${p.asset} ${p.type} token:${p.tokenDrop}%  ETH:${p.ethDrop}%`);
  console.log(`  "${p.title}"`);
}
