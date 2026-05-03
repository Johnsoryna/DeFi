/**
 * Forensic analysis: Match backtest trades to their source proposals/forum posts.
 * Extract the winning keywords/patterns that drive the 36 profitable trades.
 */
import Database from 'better-sqlite3';
import fs from 'fs';

const db = new Database('data/backtest.db');
const trades = JSON.parse(fs.readFileSync('data/backtest-trades.json', 'utf8'));

console.log(`Analyzing ${trades.length} trades...\n`);

// Group by proposalId to deduplicate
const byProposal = {};
for (const t of trades) {
  const id = t.proposalId || t.signalId || 'unknown';
  if (!byProposal[id]) byProposal[id] = [];
  byProposal[id].push(t);
}

console.log(`Unique proposals/signals: ${Object.keys(byProposal).length}`);
console.log('\n=== ALL TRADES with proposalId ===\n');

for (const t of trades) {
  console.log(`[${new Date(t.openedAt).toISOString().slice(0,10)}] ${t.asset} ${t.direction} | PnL: $${Math.round(t.pnl)} | proposalId: ${t.proposalId || 'n/a'} | signalId: ${t.signalId || 'n/a'}`);
}

// Now look up each proposal in the DB
console.log('\n\n=== PROPOSAL SOURCE LOOKUP ===\n');

const seenIds = new Set();
for (const t of trades) {
  const pid = t.proposalId;
  if (!pid || seenIds.has(pid)) continue;
  seenIds.add(pid);

  // Try forum posts
  const forumPost = db.prepare(`
    SELECT title, forum_url, created_at, body
    FROM historical_forum_posts
    WHERE topic_id = ? OR title LIKE ?
    LIMIT 1
  `).get(pid, `%${pid}%`);

  // Try snapshots
  const snapshot = db.prepare(`
    SELECT title, space, body, start
    FROM historical_snapshots
    WHERE snapshot_id = ? OR id = ?
    LIMIT 1
  `).get(pid, pid);

  const date = new Date(t.openedAt).toISOString().slice(0,10);
  const pnl = Math.round(t.pnl);

  if (forumPost) {
    console.log(`[${date}] ${t.asset} ${t.direction} $${pnl}`);
    console.log(`  SOURCE: Forum post "${forumPost.title}"`);
    console.log(`  URL: ${forumPost.forum_url}`);
    console.log(`  Created: ${forumPost.created_at?.slice(0,10)}`);
    console.log(`  Body: ${(forumPost.body || '').slice(0, 300).replace(/\n/g,' ')}`);
    console.log();
  } else if (snapshot) {
    console.log(`[${date}] ${t.asset} ${t.direction} $${pnl}`);
    console.log(`  SOURCE: Snapshot "${snapshot.title}"`);
    console.log(`  Space: ${snapshot.space}`);
    console.log(`  Body: ${(snapshot.body || '').slice(0, 300).replace(/\n/g,' ')}`);
    console.log();
  } else {
    console.log(`[${date}] ${t.asset} ${t.direction} $${pnl} | proposalId: ${pid} → NOT FOUND IN DB`);
  }
}
