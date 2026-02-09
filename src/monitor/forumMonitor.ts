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

// ─── Forum Configuration ────────────────────────────────────────────

interface ForumConfig {
  url: string
  protocol: GovernanceProtocol
  label: string
  governanceCategoryIds?: number[] // filter to only governance-related categories
}

const FORUM_CONFIGS: ForumConfig[] = [
  { url: FORUMS.aave, protocol: 'aave', label: 'Aave Forum' },
  { url: FORUMS.compound, protocol: 'compound', label: 'Compound Forum' },
  { url: FORUMS.maker, protocol: 'maker', label: 'MakerDAO Forum' },
]

// ─── Discourse API Types ────────────────────────────────────────────

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

// ─── Polling Logic ──────────────────────────────────────────────────

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
    const filtered = forumConfig.governanceCategoryIds
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
  } catch (error) {
    log.error({ err: error, forum: forumConfig.label }, 'Forum poll error')
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

// ─── Public API ─────────────────────────────────────────────────────

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
  // Background poll loop
  pollLoop().catch((err) => log.error({ err }, 'Forum poll loop crashed'))
}

export function stopForumMonitor(): void {
  running = false
  log.info('Forum monitor stopped')
}
