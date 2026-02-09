/**
 * Snapshot governance monitor.
 * Polls the Snapshot GraphQL API for active proposals in target spaces.
 */
import { createLogger } from '../lib/logger.js'
import { eventBus } from '../lib/eventBus.js'
import { config } from '../config/index.js'
import { SNAPSHOT_SPACES, APIS } from '../config/addresses.js'
import { getSnapshotCursor, setSnapshotCursor } from '../lib/store.js'
import { withRetry, sleep } from '../lib/retry.js'
import type { SnapshotProposalEvent, GovernanceProtocol } from '../types/governance.js'

const log = createLogger('snapshot')

let pollTimer: ReturnType<typeof setTimeout> | null = null
let running = false

// ─── Space to Protocol Mapping ──────────────────────────────────────

const SPACE_TO_PROTOCOL: Record<string, GovernanceProtocol> = {
  'aavedao.eth': 'aave',         // Migrated from 'aave.eth' in Jan 2026
  uniswap: 'uniswap',
  'compound-governance.eth': 'compound',
}

// ─── GraphQL Query ──────────────────────────────────────────────────

const PROPOSALS_QUERY = `
  query ActiveProposals($spaces: [String!]!) {
    proposals(
      first: 20,
      where: { space_in: $spaces, state: "active" },
      orderBy: "created",
      orderDirection: desc
    ) {
      id
      title
      body
      choices
      start
      end
      snapshot
      state
      author
      scores
      scores_total
      space { id name }
    }
  }
`

interface SnapshotProposal {
  id: string
  title: string
  body: string
  choices: string[]
  start: number
  end: number
  snapshot: string
  state: string
  author: string
  scores: number[]
  scores_total: number
  space: { id: string; name: string }
}

// ─── Polling Logic ──────────────────────────────────────────────────

async function fetchActiveProposals(): Promise<SnapshotProposal[]> {
  const response = await withRetry(
    async () => {
      const res = await fetch(APIS.snapshotGraphql, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: PROPOSALS_QUERY,
          variables: { spaces: [...SNAPSHOT_SPACES] },
        }),
      })

      if (!res.ok) throw new Error(`Snapshot API error: ${res.status}`)

      const data = (await res.json()) as { data: { proposals: SnapshotProposal[] } }
      return data.data.proposals
    },
    'snapshot-fetch',
    { maxRetries: 2, baseDelayMs: 5000 },
  )

  return response
}

async function pollOnce(): Promise<void> {
  try {
    const proposals = await fetchActiveProposals()

    for (const proposal of proposals) {
      const space = proposal.space.id
      const lastSeen = getSnapshotCursor(space)

      // Only emit for new proposals not previously seen
      if (lastSeen === proposal.id) continue

      const protocol = SPACE_TO_PROTOCOL[space]
      if (!protocol) continue

      const event: SnapshotProposalEvent = {
        type: 'snapshot_proposal',
        protocol,
        snapshotId: proposal.id,
        title: proposal.title,
        body: proposal.body,
        choices: proposal.choices,
        start: proposal.start,
        end: proposal.end,
        snapshot: proposal.snapshot,
        state: proposal.state,
        author: proposal.author,
        scores: proposal.scores,
        scoresTotal: proposal.scores_total,
        space: space,
      }

      eventBus.emit('governance:snapshot', event)
      setSnapshotCursor(space, proposal.id)
      log.info({ space, title: proposal.title, snapshotId: proposal.id }, 'New Snapshot proposal detected')
    }
  } catch (error) {
    log.error({ err: error }, 'Snapshot poll error')
  }
}

async function pollLoop(): Promise<void> {
  while (running) {
    await pollOnce()
    await sleep(config.snapshotPollIntervalMs)
  }
}

// ─── Public API ─────────────────────────────────────────────────────

export async function startSnapshotMonitor(): Promise<void> {
  running = true
  log.info(
    { spaces: SNAPSHOT_SPACES, intervalMs: config.snapshotPollIntervalMs },
    'Starting Snapshot monitor',
  )
  // Run first poll synchronously, then loop in background
  await pollOnce()
  pollLoop().catch((err) => log.error({ err }, 'Snapshot poll loop crashed'))
}

export function stopSnapshotMonitor(): void {
  running = false
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
  log.info('Snapshot monitor stopped')
}
