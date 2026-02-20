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

// â”€â”€â”€ Forum Configuration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
  { url: FORUMS.optimism, protocol: 'optimism', label: 'Optimism Forum' },
  { url: FORUMS.morpho, protocol: 'morpho', label: 'Morpho Forum' },
  // Removed: cosmos (L1 operational governance, no trading alpha)
  // Removed: 1inch (dead governance, no trades in backtest)
  // Injective removed: 0 posts in backtest DB, forum API not public
]

// â”€â”€â”€ Discourse API Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ Polling Logic â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function fetchLatestTopics(forumUrl: string): Promise<DiscourseTopic[]> {
  const response = await withRetry(
    async () => {
      const res = await fetch(`${forumUrl}/latest.json`, {
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) throw new Error(`Forum API error: ${res.status} from ${forumUrl}`)
      const data = (await res.json()) as DiscourseLatestResponse
      return data.topic_list.topics
    },
    `forum-fetch-${forumUrl}`,
    { maxRetries: 2, baseDelayMs: 5000 },
  )
  return response
}

async function pollForum(forumConfig: ForumConfig): Promise<void> {
  try {
    const topics = await fetchLatestTopics(forumConfig.url)
    const lastSeenId = getForumCursor(forumConfig.url)

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

    // Update cursor to the max topic ID
    if (topics.length > 0) {
      const maxId = Math.max(...topics.map((t) => t.id))
      if (maxId > lastSeenId) {
        setForumCursor(forumConfig.url, maxId)
      }
    }
  } catch (_error) {
    // Downgrade to warn for forums that are unreachable (e.g. Injective returns HTML)
    // These still match backtest config but may not have public Discourse API access
    log.warn({ forum: forumConfig.label }, 'Forum poll failed — will retry next cycle')
  }
}

async function pollLoop(): Promise<void> {
  while (running) {
    for (const forumConfig of FORUM_CONFIGS) {
      await pollForum(forumConfig)
      // Small delay between forums to spread load
      await sleep(2000)
    }
    await sleep(config.forumPollIntervalMs)
  }
}

// â”€â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function startForumMonitor(): Promise<void> {
  running = true
  log.info(
    { forums: FORUM_CONFIGS.map((f) => f.label), intervalMs: config.forumPollIntervalMs },
    'Starting forum monitor',
  )
  // Initial poll
  for (const forumConfig of FORUM_CONFIGS) {
    await pollForum(forumConfig)
  }
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
