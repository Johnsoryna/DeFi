/**
 * Collect historical Snapshot proposals + forum posts for new protocols.
 * Updated 2026-02-15: Added Tier A governance tokens from dYdX v4 research.
 * Updated 2026-02-20: Added Gruppe B candidates (PENDLE, FXS, BAL).
 */
import Database from 'better-sqlite3'
import { collectForumPosts, collectSnapshots } from '../src/backtest/dataCollector.js'

const DB_PATH = 'data/backtest.db'
const db = new Database(DB_PATH)

const FROM = new Date('2025-01-01T00:00:00Z')
const TO = new Date('2026-02-20T00:00:00Z')

async function main() {
  console.log('=== Collecting Forum Posts for New Tier A Protocols ===')

  // New Tier A protocols (forums that likely run Discourse)
  const newForums: Record<string, string> = {
    cosmos: 'https://forum.cosmos.network',
    near: 'https://gov.near.org',
    injective: 'https://gov.injective.network',
    jito: 'https://forum.jito.network',
    zksync: 'https://forum.zknation.io',
    drift: 'https://driftgov.discourse.group',
    pyth: 'https://forum.pyth.network',
    stacks: 'https://forum.stacks.org',
    axelar: 'https://community.axelar.network',
    // Gruppe B: yield/stablecoin protocols with DeFi-risk governance
    pendle: 'https://forum.pendle.finance',
    frax: 'https://gov.frax.finance',
    // Aptos uses GitHub AIPs, not Discourse
    // Balancer forum: checked, Discourse-based but mostly gauge votes (expect 0 alpha)
    balancer: 'https://forum.balancer.fi',
  }
  const forumCount = await collectForumPosts(db, newForums, FROM, TO)
  console.log(`Collected ${forumCount} new forum posts`)

  // ─── Gruppe B: Snapshot spaces ───────────────────────────────────────
  console.log('\n=== Collecting Snapshot Proposals for Gruppe B ===')
  const gruppeB_spaces = [
    'pendle-politics.eth',   // Pendle governance
    'frax.eth',              // Frax Finance
    'balancer.eth',          // Balancer (likely mostly gauge-weight votes → expect 0)
  ]
  const snapCount = await collectSnapshots(db, gruppeB_spaces, FROM, TO)
  console.log(`Collected ${snapCount} new Snapshot proposals for Gruppe B`)

  // Summary
  console.log('\n=== SUMMARY ===')
  const forums = db.prepare('SELECT forum_url, COUNT(*) as c FROM historical_forum_posts GROUP BY forum_url ORDER BY c DESC').all() as any[]
  console.log('\nForum posts by URL:')
  forums.forEach((f: any) => console.log(`  ${f.c} ${f.forum_url}`))

  const snaps = db.prepare('SELECT space, COUNT(*) as c FROM historical_snapshots GROUP BY space ORDER BY c DESC').all() as any[]
  console.log('\nSnapshot proposals by space:')
  snaps.forEach((s: any) => console.log(`  ${s.c} ${s.space}`))
}

main().catch(console.error)
