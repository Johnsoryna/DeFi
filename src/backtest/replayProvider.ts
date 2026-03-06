/**
 * Event replay provider for backtesting.
 * Reads historical data from the cache database, sorts chronologically,
 * and emits events through the existing eventBus with VirtualClock advancing.
 */
import type Database from 'better-sqlite3'
import type { VirtualClock } from './clock.js'
import { eventBus } from '../lib/eventBus.js'
import { createLogger } from '../lib/logger.js'
import { GOVERNANCE } from '../config/addresses.js'
import type {
  GovernanceProtocol,
  GovernanceEvent,
  ProposalCreatedEvent,
  VoteCastEvent,
  ProposalQueuedEvent,
  ProposalExecutedEvent,
  SnapshotProposalEvent,
  ForumPostEvent,
} from '../types/governance.js'

const log = createLogger('replay')

// â”€â”€â”€ Unified Timeline Event â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface TimelineEvent {
  timestamp: number
  type: string
  emit: () => void
}

// â”€â”€â”€ Contract → Protocol Mapping â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const CONTRACT_PROTOCOL: Record<string, GovernanceProtocol> = {
  [GOVERNANCE.compoundGovernorBravo.toLowerCase()]: 'compound',
  [GOVERNANCE.uniswapGovernorBravo.toLowerCase()]: 'uniswap',
  [GOVERNANCE.aaveGovernanceCore.toLowerCase()]: 'aave',
  [GOVERNANCE.aaveVotingMachine.toLowerCase()]: 'aave',
  // Cosmos SDK chains (synthetic addresses from migration script)
  ['0x' + 'cosmos'.padEnd(40, '0')]: 'cosmos',
  ['0x' + 'inject'.padEnd(40, '0')]: 'injective',
  ['0x' + 'arbtrum'.padEnd(40, '0')]: 'arbitrum',
}

// â”€â”€â”€ Snapshot Space → Protocol Mapping â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Must match snapshotMonitor.ts SPACE_TO_PROTOCOL exactly for live/backtest parity.
// Any space not in this map is ignored during replay (same as live ignoring unsubscribed spaces).
const SPACE_PROTOCOL: Record<string, GovernanceProtocol> = {
  'aavedao.eth': 'aave',
  'compound-governance.eth': 'compound',
  'arbitrumfoundation.eth': 'arbitrum',
  'dydxgov.eth': 'dydx',
  '1inch.eth': '1inch',
  'cvx.eth': 'convex',
  'veyfi.eth': 'yearn',
  'lido-snapshot.eth': 'lido',
  'gmx.eth': 'gmx',
  'ethenagovernance.eth': 'ethena',
  'starknet.eth': 'starknet',
  'ens.eth': 'ens',
  'morpho.eth': 'morpho',
  'snxgov.eth': 'synthetix',
  // ─── Mar 2026 ────────────────────────────────────────────────────────────
  'etherfi-dao.eth': 'etherfi',
  // ─── Removed (0 trades, not in live monitor) ─────────────────────────────
  // 'eulerdao.eth': 0 trades (routine Gauntlet params, neutral sentiment)
  // 'frax.eth': 0 trades in backtest
  // 'pendle-politics.eth': 0 proposals in DB
  // 'graphprotocol.eth': 0 trades (team updates/council meetings)
  // 'balancer.eth': no Binance USDT perp for BAL (delisted)
  // 'venus-xvs.eth': 0 trades (asset listing proposals, conf <0.55)
  // 'rocketpool-dao.eth': 0 trades (partnership proposals, no risk-param alpha)
}

// â”€â”€â”€ Forum URL → Protocol Mapping â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Must match forumMonitor.ts FORUM_CONFIGS exactly for live/backtest parity.
// Any forum URL not in this map is ignored during replay (same as live ignoring unmonitored forums).
// All removed entries generated 0 backtest trades — no P&L impact.
const FORUM_PROTOCOL: Record<string, GovernanceProtocol> = {
  'https://governance.aave.com': 'aave',
  'https://www.comp.xyz': 'compound',
  'https://forum.arbitrum.foundation': 'arbitrum',
  'https://dydx.forum': 'dydx',
  'https://research.lido.fi': 'lido',
  'https://forum.makerdao.com': 'maker',
  'https://gov.optimism.io': 'optimism',
  'https://forum.morpho.org': 'morpho',
  'https://gov.curve.fi': 'curve',
  'https://gov.uniswap.org': 'uniswap',
  'https://forum.eigenlayer.xyz': 'eigenlayer',
  // ─── New L2/L1 forums (Mar 2026) — data in DB, now wired for replay ─────────
  'https://forum.zknation.io': 'zksync',    // 190 posts
  'https://discuss.jup.ag': 'jupiter',      // 165 posts
  'https://forum.stacks.org': 'stacks',     // 94 posts
  // ─── New protocols (Mar 2026) ─────────────────────────────────────────────
  'https://forum.wormhole.com': 'wormhole', // Wormhole bridge governance forum
  'https://forum.ether.fi': 'etherfi',      // Ether.fi — currently auth-required, wired for future
}

// â”€â”€â”€ Event Construction Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildGovernanceEvent(row: any): { busEvent: string; payload: GovernanceEvent } | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let args: any
  try {
    args = JSON.parse(row.args_json)
  } catch (err) {
    log.error({ err, row_id: row.id, args_json: row.args_json?.slice(0, 100) }, 'Failed to parse governance event args_json')
    return null
  }
  const protocol = CONTRACT_PROTOCOL[row.contract_address]
  if (!protocol) {
    // Skip on-chain events from contracts not explicitly mapped — avoids misattributing
    // unknown contracts as 'compound' which would corrupt backtest signal attribution.
    log.warn({ contract: row.contract_address, eventName: row.event_name, rowId: row.id }, 'Skipping unmapped governance contract')
    return null
  }
  const base = {
    protocol,
    blockNumber: BigInt(row.block_number),
    transactionHash: row.tx_hash,
    logIndex: row.log_index,
    timestamp: row.timestamp,
    removed: false,
  }

  switch (row.event_name) {
    case 'ProposalCreated': {
      // Handle both numeric and string proposal IDs (Cosmos chains use numeric, others may use strings)
      let proposalId: bigint
      const rawId = args.id ?? args.proposalId ?? '0'
      try {
        // Try to extract numeric part if it's a prefixed string (e.g., "inj-552" → 552)
        const match = rawId.toString().match(/\d+/)
        proposalId = BigInt(match ? match[0] : rawId)
      } catch {
        proposalId = 0n
      }
      
      const event: ProposalCreatedEvent = {
        ...base,
        type: 'proposal_created',
        proposalId,
        proposer: args.proposer ?? args.creator ?? '',
        targets: args.targets ?? [],
        values: (args.values ?? []).map((v: string) => BigInt(v)),
        signatures: args.signatures ?? [],
        calldatas: args.calldatas ?? [],
        startBlock: args.startBlock ? BigInt(args.startBlock) : undefined,
        endBlock: args.endBlock ? BigInt(args.endBlock) : undefined,
        description: args.description ?? '',
      }
      return { busEvent: 'governance:proposal', payload: event }
    }

    case 'VoteCast':
    case 'VoteEmitted': {
      const event: VoteCastEvent = {
        ...base,
        type: 'vote_cast',
        proposalId: BigInt(args.proposalId ?? '0'),
        voter: args.voter ?? '',
        support: Number(args.support ?? 0),
        votes: BigInt(args.votes ?? args.votingPower ?? '0'),
        reason: args.reason,
      }
      return { busEvent: 'governance:vote', payload: event }
    }

    case 'ProposalQueued': {
      const event: ProposalQueuedEvent = {
        ...base,
        type: 'proposal_queued',
        proposalId: BigInt(args.id ?? args.proposalId ?? '0'),
        eta: args.eta ? BigInt(args.eta) : undefined,
        votesFor: args.votesFor ? BigInt(args.votesFor) : undefined,
        votesAgainst: args.votesAgainst ? BigInt(args.votesAgainst) : undefined,
      }
      return { busEvent: 'governance:queued', payload: event }
    }

    case 'ProposalExecuted': {
      const event: ProposalExecutedEvent = {
        ...base,
        type: 'proposal_executed',
        proposalId: BigInt(args.id ?? args.proposalId ?? '0'),
      }
      return { busEvent: 'governance:executed', payload: event }
    }

    default:
      return null
  }
}

/** DB may store timestamps in ms (dataCollector) or seconds (legacy). Normalize to ms for timeline. */
function createdAtMs(row: { created_at: number }): number {
  const t = row.created_at
  return t > 0 && t < 1e12 ? t * 1000 : t
}

/** SnapshotProposalEvent.start/end are in Unix seconds (same as live API). DB stores ms; convert if needed. */
function toSeconds(value: number): number {
  return value >= 1e12 ? Math.floor(value / 1000) : value
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildSnapshotEvent(row: any): { busEvent: string; payload: SnapshotProposalEvent } | null {
  const protocol = SPACE_PROTOCOL[row.space]
  if (!protocol) {
    // Skip Snapshot spaces we don't explicitly support â€” avoid noise from unknown protocols
    return null
  }

  let scores: number[] = []
  let choices: string[] = []

  try {
    scores = JSON.parse(row.scores_json ?? '[]')
  } catch (err) {
    log.debug({ err, row_id: row.id }, 'Failed to parse scores_json')
  }

  try {
    choices = JSON.parse(row.choices_json ?? '[]')
  } catch (err) {
    log.debug({ err, row_id: row.id }, 'Failed to parse choices_json')
  }

  const event: SnapshotProposalEvent = {
    type: 'snapshot_proposal',
    protocol,
    snapshotId: row.proposal_id,
    title: row.title,
    body: row.body ?? '',
    choices,
    start: toSeconds(row.start),
    end: toSeconds(row.end),
    snapshot: '',
    state: row.state,
    author: row.author ?? '',
    scores,
    scoresTotal: row.scores_total ?? 0,
    space: row.space,
  }

  return { busEvent: 'governance:snapshot', payload: event }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildForumEvent(row: any): { busEvent: string; payload: ForumPostEvent } | null {
  const protocol = FORUM_PROTOCOL[row.forum_url]
  if (!protocol) {
    // Skip forums we don't explicitly support â€” fallback to 'compound' would create noise signals
    return null
  }

  const event: ForumPostEvent = {
    type: 'forum_post',
    protocol,
    forumUrl: row.forum_url,
    topicId: row.topic_id,
    title: row.title,
    categoryId: row.category_id ?? 0,
    createdAt: row.created_at,
    postsCount: row.posts_count ?? 0,
    replyCount: row.reply_count ?? 0,
    views: row.views ?? 0,
  }

  return { busEvent: 'governance:forum', payload: event }
}

// â”€â”€â”€ Replay Provider â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export class EventReplayProvider {
  constructor(
    private db: Database.Database,
    private clock: VirtualClock,
  ) {}

  /**
   * Replay all historical events in chronological order.
   * Advances the virtual clock and emits through eventBus.
   */
  async replay(from: Date, to: Date, onTick?: () => void): Promise<{ eventsReplayed: number }> {
    const fromMs = from.getTime()
    const toMs = to.getTime()
    const timeline: TimelineEvent[] = []

    // 1. Load governance events
    const govRows = this.db.prepare(
      `SELECT * FROM historical_events WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC`,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ).all(fromMs, toMs) as any[]

    for (const row of govRows) {
      const result = buildGovernanceEvent(row)
      if (result) {
        timeline.push({
          timestamp: row.timestamp,
          type: result.busEvent,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          emit: () => eventBus.emit(result.busEvent as any, result.payload as any),
        })
      }
    }

    // 2. Load Snapshot proposals
    // created_at: dataCollector stores ms (p.start*1000); legacy/other paths may store seconds. Query both ranges and dedupe.
    const fromSec = Math.floor(fromMs / 1000)
    const toSec = Math.ceil(toMs / 1000)
    const snapByMs = this.db.prepare(
      `SELECT * FROM historical_snapshots WHERE created_at >= ? AND created_at <= ? ORDER BY created_at ASC`,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ).all(fromMs, toMs) as any[]
    const snapBySec = this.db.prepare(
      `SELECT * FROM historical_snapshots WHERE created_at >= ? AND created_at <= ? ORDER BY created_at ASC`,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ).all(fromSec, toSec) as any[]
    const seenIds = new Set<string>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapRows: any[] = []
    for (const row of snapByMs) {
      if (!seenIds.has(row.proposal_id)) {
        seenIds.add(row.proposal_id)
        snapRows.push(row)
      }
    }
    for (const row of snapBySec) {
      if (!seenIds.has(row.proposal_id)) {
        seenIds.add(row.proposal_id)
        snapRows.push(row)
      }
    }
    snapRows.sort((a, b) => createdAtMs(a) - createdAtMs(b))

    for (const row of snapRows) {
      const result = buildSnapshotEvent(row)
      if (!result) continue // Skip unmapped Snapshot spaces
      const tsMs = createdAtMs(row)
      timeline.push({
        timestamp: tsMs,
        type: result.busEvent,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        emit: () => eventBus.emit(result.busEvent as any, result.payload as any),
      })
    }

    // 3. Load forum posts
    const forumRows = this.db.prepare(
      `SELECT * FROM historical_forum_posts WHERE created_at >= ? AND created_at <= ? ORDER BY created_at ASC`,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ).all(new Date(fromMs).toISOString(), new Date(toMs).toISOString()) as any[]

    for (const row of forumRows) {
      const result = buildForumEvent(row)
      if (!result) continue // Skip unmapped forum URLs
      const ts = new Date(row.created_at).getTime()
      timeline.push({
        timestamp: ts,
        type: result.busEvent,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        emit: () => eventBus.emit(result.busEvent as any, result.payload as any),
      })
    }

    // 4. Sort all events chronologically
    timeline.sort((a, b) => a.timestamp - b.timestamp)

    log.info(
      { totalEvents: timeline.length, from: from.toISOString(), to: to.toISOString() },
      'Starting event replay',
    )

    // 5. Replay events, advancing clock before each emission
    // CRITICAL: Inject intermediate ticks between events for accurate SL/TP
    let replayed = 0
    let lastTickTs = fromMs
    const TICK_INTERVAL_MS = 1 * 3600_000 // Check exits every 1 simulated hour (reduces max-loss-cap overshoot)
    for (const event of timeline) {
      // Inject intermediate ticks if there's a large gap between events
      if (onTick) {
        while (lastTickTs + TICK_INTERVAL_MS < event.timestamp) {
          lastTickTs += TICK_INTERVAL_MS
          this.clock.advanceTo(lastTickTs)
          onTick()
        }
      }

      this.clock.advanceTo(event.timestamp)

      // Tick at each event time
      if (onTick && event.timestamp - lastTickTs >= TICK_INTERVAL_MS) {
        onTick()
        lastTickTs = event.timestamp
      }

      event.emit()
      replayed++

      // Yield to the event loop so downstream listeners can process
      if (replayed % 500 === 0) {
        await new Promise((resolve) => setImmediate(resolve))
        log.debug({ replayed, total: timeline.length }, 'Replay progress')
      }
    }

    // Advance clock to end of period with final ticks
    if (onTick) {
      while (lastTickTs + TICK_INTERVAL_MS < toMs) {
        lastTickTs += TICK_INTERVAL_MS
        this.clock.advanceTo(lastTickTs)
        onTick()
      }
    }
    this.clock.advanceTo(toMs)

    log.info({ eventsReplayed: replayed }, 'Event replay complete')
    return { eventsReplayed: replayed }
  }
}
