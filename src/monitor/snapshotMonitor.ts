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

let running = false

// ─── Space to Protocol Mapping ──────────────────────────────────────

const SPACE_TO_PROTOCOL: Record<string, GovernanceProtocol> = {
  // Must match backtest SPACE_PROTOCOL exactly
  'aavedao.eth': 'aave',
  'compound-governance.eth': 'compound',
  'arbitrumfoundation.eth': 'arbitrum',
  'dydxgov.eth': 'dydx',
  '1inch.eth': '1inch',
  'cvx.eth': 'convex',
  'veyfi.eth': 'yearn',
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

    // Track the latest proposal ID per space to update cursor once at the end
    const latestPerSpace = new Map<string, string>()

    for (const proposal of proposals) {
      const space = proposal.space.id
      const lastSeen = getSnapshotCursor(space)

      // Track the latest proposal ID for this space
      if (!latestPerSpace.has(space) || proposal.id > (latestPerSpace.get(space) ?? '')) {
        latestPerSpace.set(space, proposal.id)
      }

      // Only emit for new proposals not previously seen
      // Check if proposal ID is newer than last seen (string comparison works for Snapshot IDs)
      if (lastSeen && proposal.id <= lastSeen) continue

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
      log.info({ space, title: proposal.title, snapshotId: proposal.id }, 'New Snapshot proposal detected')
    }

    // Update cursors to the latest seen ID per space
    for (const [space, latestId] of latestPerSpace) {
      setSnapshotCursor(space, latestId)
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
  // Run first poll synchronously, then loop in background with auto-restart
  await pollOnce()
  function startPollLoop() {
    pollLoop().catch((err) => {
      log.error({ err }, 'Snapshot poll loop crashed, restarting in 10s')
      if (running) setTimeout(startPollLoop, 10_000)
    })
  }
  startPollLoop()
}

export function stopSnapshotMonitor(): void {
  running = false
  log.info('Snapshot monitor stopped')
}
