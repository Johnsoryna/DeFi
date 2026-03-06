/**
 * Discourse forum monitor.
 * Polls /latest.json on Aave, Compound, and MakerDAO governance forums.
 */
import { createLogger } from '../lib/logger.js'
import { eventBus } from '../lib/eventBus.js'
import { config } from '../config/index.js'
import { FORUMS } from '../config/addresses.js'
import { getForumCursor, setForumCursor } from '../lib/store.js'
import { withRetry, sleep } from '../lib/retry.js'
import type { ForumPostEvent, GovernanceProtocol } from '../types/governance.js'

const log = createLogger('forum')

let running = false

// ─── Forum Configuration ─────────────────────────────────────────────

interface ForumConfig {
  url: string
  protocol: GovernanceProtocol
  label: string
  governanceCategoryIds?: number[] // filter to only governance-related categories
}

const FORUM_CONFIGS: ForumConfig[] = [
  // Must match backtest FORUM_PROTOCOL — only forums with actual data and positive PnL
  { url: FORUMS.aave, protocol: 'aave', label: 'Aave Forum' },
  { url: FORUMS.compound, protocol: 'compound', label: 'Compound Forum' },
  { url: FORUMS.arbitrum, protocol: 'arbitrum', label: 'Arbitrum Forum' },
  { url: FORUMS.dydx, protocol: 'dydx', label: 'dYdX Forum' },
  // Added Feb 2026: Tier1 protocols that were missing from live monitor
  { url: FORUMS.lido, protocol: 'lido', label: 'Lido Research Forum' },
  { url: FORUMS.maker, protocol: 'maker', label: 'MakerDAO Forum' },
  { url: FORUMS.morpho, protocol: 'morpho', label: 'Morpho Forum' },
  // Curve: 3 backtest trades, WR 67%, +$4,516 — alpha from forum posts ONLY (not Snapshot).
  // gov.curve.fi is a Discourse forum (risk param changes, gauge controller updates).
  // NOTE: Curve SNAPSHOT proposals (gauge weight votes) have no alpha and are correctly
  // excluded via NON_ALPHA_SNAPSHOT_PROTOCOLS in index.ts. Forum != Snapshot.
  { url: FORUMS.curve, protocol: 'curve', label: 'Curve Governance Forum' },
  // Uniswap: gov.uniswap.org Discourse forum — added Mar 2026.
  // UNI has Binance perp (UNIUSDT), established protocol, risk-param governance.
  { url: FORUMS.uniswap, protocol: 'uniswap', label: 'Uniswap Governance Forum' },
  // EigenLayer: forum.eigenlayer.xyz — 1 backtest trade (EIGEN), added Mar 2026.
  // EIGENUSDT Binance perp exists. Risk-param / slashing events move EIGEN price.
  { url: FORUMS.eigenlayer, protocol: 'eigenlayer', label: 'EigenLayer Governance Forum' },
  // ─── Removed (0 trades, no risk-parameter alpha) ─────────────────────────
  // optimism: L2 stablecoin filter blocks all signals, 0 trades
  // zksync: L2 operational governance (routing/sequencer), 0 trades after 190 posts
  // jupiter: treasury/fee distribution governance, 0 trades after 165 posts
  // stacks: PoX mechanism/BTC-peg operational governance, 0 trades after 94 posts
  // wormhole: delegate platforms + support tickets, 0 trades
  // cosmos/1inch/injective: operational/treasury governance, 0 trades
]

// ─── Discourse API Types ─────────────────────────────────────────────

interface DiscourseTopic {
  id: number
  title: string
  category_id: number
  created_at: string
  posts_count: number
  reply_count: number
  views: number
  slug: string
}

interface DiscourseLatestResponse {
  topic_list: {
    topics: DiscourseTopic[]
  }
}

// ─── Polling Logic ───────────────────────────────────────────────────

const FORUM_PAGE_LIMIT = 20
const DISCOURSE_PAGE_SIZE = 30

async function fetchLatestTopicsPage(forumUrl: string, page: number): Promise<DiscourseTopic[]> {
  const suffix = page > 0 ? `?page=${page}` : ''
  return withRetry(
    async () => {
      const res = await fetch(`${forumUrl}/latest.json${suffix}`, {
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) throw new Error(`Forum API error: ${res.status} from ${forumUrl}`)
      const data = (await res.json()) as DiscourseLatestResponse
      return data.topic_list.topics
    },
    `forum-fetch-${forumUrl}-p${page}`,
    { maxRetries: 2, baseDelayMs: 5000 },
  )
}

async function fetchLatestTopics(forumUrl: string, stopAtOrBelowTopicId: number): Promise<DiscourseTopic[]> {
  const merged: DiscourseTopic[] = []
  const seen = new Set<number>()
  let reachedCursor = false

  for (let page = 0; page < FORUM_PAGE_LIMIT; page++) {
    const batch = await fetchLatestTopicsPage(forumUrl, page)
    for (const topic of batch) {
      if (seen.has(topic.id)) continue
      seen.add(topic.id)
      merged.push(topic)
      if (stopAtOrBelowTopicId > 0 && topic.id <= stopAtOrBelowTopicId) {
        reachedCursor = true
      }
    }
    if (batch.length < DISCOURSE_PAGE_SIZE || reachedCursor) break
  }

  return merged
}

async function pollForum(forumConfig: ForumConfig): Promise<void> {
  try {
    const lastSeenId = getForumCursor(forumConfig.url)
    const topics = await fetchLatestTopics(forumConfig.url, lastSeenId)

    // isFirstRun: cursor is 0 (no cursor stored yet — new or recreated governance.db).
    // On first run we only initialise the cursor — we do NOT emit historical topics
    // (avoids replaying dozens of topics as "new" and potentially spamming trades).
    const isFirstRun = lastSeenId === 0

    // Always update cursor to the highest topic ID seen — do this BEFORE any early return
    // so that the cursor is set even when we skip emission on first run.
    if (topics.length > 0) {
      const maxId = Math.max(...topics.map((t) => t.id))
      if (maxId > lastSeenId) {
        setForumCursor(forumConfig.url, maxId)
      }
    }

    // On first run: cursor is now initialised — skip all emissions
    if (isFirstRun) {
      log.debug({ forum: forumConfig.label }, 'First run — cursor initialized, skipping historical topics')
      return
    }

    // Filter new topics since last seen
    const newTopics = topics.filter((t) => t.id > lastSeenId)

    // Optionally filter by governance category IDs
    const filtered = forumConfig.governanceCategoryIds && Array.isArray(forumConfig.governanceCategoryIds)
      ? newTopics.filter((t) => forumConfig.governanceCategoryIds!.includes(t.category_id))
      : newTopics

    for (const topic of filtered) {
      const event: ForumPostEvent = {
        type: 'forum_post',
        protocol: forumConfig.protocol,
        forumUrl: forumConfig.url,
        topicId: topic.id,
        title: topic.title,
        categoryId: topic.category_id,
        createdAt: topic.created_at,
        postsCount: topic.posts_count,
        replyCount: topic.reply_count,
        views: topic.views,
      }

      eventBus.emit('governance:forum', event)
      log.info(
        { protocol: forumConfig.label, topicId: topic.id, title: topic.title },
        'New forum topic detected',
      )
    }
  } catch (_error) {
    // Downgrade to warn for forums that are unreachable (e.g. Injective returns HTML)
    // These still match backtest config but may not have public Discourse API access
    log.warn({ forum: forumConfig.label }, 'Forum poll failed — will retry next cycle')
  }
}

async function pollLoop(): Promise<void> {
  while (running) {
    // Poll all forums in parallel — each has independent error handling.
    // Previously sequential with 2s delays (16s+ extra per cycle for 9 forums).
    await Promise.all(FORUM_CONFIGS.map((forumConfig) => pollForum(forumConfig)))
    await sleep(config.forumPollIntervalMs)
  }
}

// ─── Public API ──────────────────────────────────────────────────────

export async function startForumMonitor(): Promise<void> {
  running = true
  log.info(
    { forums: FORUM_CONFIGS.map((f) => f.label), intervalMs: config.forumPollIntervalMs },
    'Starting forum monitor',
  )
  // Initial poll — run in parallel
  await Promise.all(FORUM_CONFIGS.map((forumConfig) => pollForum(forumConfig)))
  // Background poll loop with auto-restart
  function startPollLoop() {
    pollLoop().catch((err) => {
      log.error({ err }, 'Forum poll loop crashed, restarting in 10s')
      if (running) setTimeout(startPollLoop, 10_000)
    })
  }
  startPollLoop()
}

export function stopForumMonitor(): void {
  running = false
  log.info('Forum monitor stopped')
}
