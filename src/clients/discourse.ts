/**
 * Discourse forum API client.
 * All governance forums are public with JSON endpoints, no auth needed.
 * Rate limit: ~200 req/min for anonymous users.
 */
import { createLogger } from '../lib/logger.js'
import { withRetry } from '../lib/retry.js'

const log = createLogger('discourse')

// ─── Types ──────────────────────────────────────────────────────────

export interface DiscourseTopic {
  id: number
  title: string
  slug: string
  category_id: number
  created_at: string
  posts_count: number
  reply_count: number
  views: number
  like_count: number
  last_posted_at: string
}

export interface DiscoursePost {
  id: number
  topic_id: number
  raw: string
  cooked: string
  username: string
  created_at: string
}

// ─── API Methods ────────────────────────────────────────────────────

/**
 * Get the latest topics from a Discourse forum.
 */
export async function getLatestTopics(baseUrl: string): Promise<DiscourseTopic[]> {
  return withRetry(
    async () => {
      const res = await fetch(`${baseUrl}/latest.json`, {
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) throw new Error(`Discourse ${res.status}: ${baseUrl}/latest.json`)
      const data = (await res.json()) as { topic_list: { topics: DiscourseTopic[] } }
      return data.topic_list.topics
    },
    `discourse-latest-${baseUrl}`,
    { maxRetries: 2, baseDelayMs: 3000 },
  )
}

/**
 * Get a specific topic by slug and ID.
 */
export async function getTopic(
  baseUrl: string,
  slug: string,
  id: number,
): Promise<{ title: string; posts: DiscoursePost[] } | null> {
  try {
    return await withRetry(
      async () => {
        const res = await fetch(`${baseUrl}/t/${slug}/${id}.json`, {
          headers: { Accept: 'application/json' },
        })
        if (!res.ok) throw new Error(`Discourse ${res.status}: topic ${id}`)
        const data = (await res.json()) as any
        return {
          title: data.title,
          posts: (data.post_stream?.posts ?? []).map((p: any) => ({
            id: p.id,
            topic_id: p.topic_id,
            raw: p.raw ?? '',
            cooked: p.cooked ?? '',
            username: p.username,
            created_at: p.created_at,
          })),
        }
      },
      `discourse-topic-${id}`,
      { maxRetries: 2, baseDelayMs: 3000 },
    )
  } catch {
    return null
  }
}

/**
 * Search topics on a Discourse forum.
 */
export async function searchTopics(
  baseUrl: string,
  query: string,
): Promise<DiscourseTopic[]> {
  return withRetry(
    async () => {
      const res = await fetch(`${baseUrl}/search.json?q=${encodeURIComponent(query)}`, {
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) throw new Error(`Discourse search ${res.status}`)
      const data = (await res.json()) as { topics?: DiscourseTopic[] }
      return data.topics ?? []
    },
    `discourse-search-${query}`,
    { maxRetries: 1, baseDelayMs: 3000 },
  )
}
