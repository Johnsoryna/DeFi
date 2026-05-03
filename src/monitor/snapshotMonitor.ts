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
  'veyfi.eth': 'yearn',
  'lido-snapshot.eth': 'lido',
  'gmx.eth': 'gmx',
  'morpho.eth': 'morpho',
  'snxgov.eth': 'synthetix',
  // ─── Removed ────────────────────────────────────────────────────────
  // ─── Removed (0 trades, no risk-parameter alpha) ─────────────────────────
  // '1inch.eth': fusion protocol operational governance
  // 'cvx.eth': 563 gauge-weight votes, NLP correctly rejects all
  // 'ethenagovernance.eth': ENA cascade via COLLATERAL_ISSUER_TOKEN, no protocol monitor needed
  // 'starknet.eth': L2 operational governance
  // 'ens.eth': treasury/delegate compensation governance
  // 'etherfi-dao.eth': treasury/buyback/seasonal rewards (Mar 2026)
  // 'frax.eth': 0 trades in backtest
  // 'balancer.eth': no BALUSDT Binance perp (delisted)
}

// ─── GraphQL Query ──────────────────────────────────────────────────

const PAGE_SIZE = 100

const PROPOSALS_QUERY = `
  query ActiveProposals($spaces: [String!]!, $skip: Int!) {
    proposals(
      first: 100,
      skip: $skip,
      where: { space_in: $spaces, state: "active" },
      orderBy: "created",
      orderDirection: desc
    ) {
      id
      title
      body
      choices
      created
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
  created: number
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

async function fetchActiveProposalPage(skip: number): Promise<SnapshotProposal[]> {
  return withRetry(
    async () => {
      const res = await fetch(APIS.snapshotGraphql, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: PROPOSALS_QUERY,
          variables: { spaces: [...SNAPSHOT_SPACES], skip },
        }),
      })

      if (!res.ok) throw new Error(`Snapshot API error: ${res.status}`)

      const data = (await res.json()) as { data: { proposals: SnapshotProposal[] } }
      return data.data.proposals
    },
    `snapshot-fetch-page-${skip}`,
    { maxRetries: 2, baseDelayMs: 5000 },
  )
}

async function fetchActiveProposals(): Promise<SnapshotProposal[]> {
  const all: SnapshotProposal[] = []
  const seen = new Set<string>()
  const MAX_PAGES = 20

  for (let page = 0; page < MAX_PAGES; page++) {
    const skip = page * PAGE_SIZE
    const batch = await fetchActiveProposalPage(skip)

    for (const proposal of batch) {
      if (seen.has(proposal.id)) continue
      seen.add(proposal.id)
      all.push(proposal)
    }

    if (batch.length < PAGE_SIZE) break
  }

  return all
}

async function pollOnce(): Promise<void> {
  try {
    const proposals = await fetchActiveProposals()

    // Track the latest created timestamp per space (numeric — reliable ordering unlike 0x IDs)
    const latestPerSpace = new Map<string, number>()

    for (const proposal of proposals) {
      const space = proposal.space.id
      const lastSeenStr = getSnapshotCursor(space)
      // isFirstRun: no cursor for this space yet (new or recreated governance.db).
      // On first run we only initialise the cursor — we do NOT emit events for proposals
      // that were already active before the bot started (avoids replay-triggered orders).
      const isFirstRun = lastSeenStr === null
      const lastSeenTs = isFirstRun ? 0 : parseInt(lastSeenStr, 10)

      // Track the highest created timestamp seen for this space
      const cur = latestPerSpace.get(space) ?? 0
      if (proposal.created > cur) {
        latestPerSpace.set(space, proposal.created)
      }

      // Skip: first run (cursor initialisation only) or proposal not newer than cursor
      if (isFirstRun || proposal.created <= lastSeenTs) continue

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

    // Update cursors to the latest created timestamp seen per space
    for (const [space, latestTs] of latestPerSpace) {
      setSnapshotCursor(space, String(latestTs))
    }

    // For known spaces that had NO active proposals in this poll (so latestPerSpace has no entry),
    // still initialize their cursor to "now" if they have never been set.
    // Without this, the first real proposal in such a space would be incorrectly treated as
    // "first run" (isFirstRun=true) and silently skipped — causing missed alpha.
    const nowSec = Math.floor(Date.now() / 1000)
    for (const space of Object.keys(SPACE_TO_PROTOCOL)) {
      if (getSnapshotCursor(space) === null) {
        setSnapshotCursor(space, String(nowSec))
        log.debug({ space }, 'No active proposals on first poll — cursor initialized to now')
      }
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
