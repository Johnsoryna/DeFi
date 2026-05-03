/**
 * Governor Bravo event monitor — shared by Compound and Uniswap.
 * Watches ProposalCreated, VoteCast, ProposalQueued, ProposalExecuted.
 * Handles chain reorgs, reconnection, and backfill.
 */
import { type WatchContractEventReturnType, type Log } from 'viem'
import { getReadClient, getPaginatedLogs, getCurrentBlock } from '../clients/rpc.js'
import { governorBravoAbi } from '../config/abis/governorBravo.js'
import { GOVERNANCE } from '../config/addresses.js'
import { eventBus } from '../lib/eventBus.js'
import { createLogger } from '../lib/logger.js'
import {
  getLastProcessedBlock,
  setLastProcessedBlock,
  isEventProcessed,
  markEventProcessed,
  rollbackEvent,
  getProposal,
} from '../lib/store.js'
import { config } from '../config/index.js'
import type {
  GovernanceProtocol,
  ProposalCreatedEvent,
  VoteCastEvent,
  ProposalQueuedEvent,
  ProposalExecutedEvent,
  ProposalCanceledEvent,
} from '../types/governance.js'

const log = createLogger('governor-bravo')

interface GovernorBravoConfig {
  address: `0x${string}`
  protocol: GovernanceProtocol
  label: string
}

const GOVERNORS: GovernorBravoConfig[] = [
  {
    address: GOVERNANCE.compoundGovernorBravo as `0x${string}`,
    protocol: 'compound',
    label: 'Compound',
  },
  {
    address: GOVERNANCE.uniswapGovernorBravo as `0x${string}`,
    protocol: 'uniswap',
    label: 'Uniswap',
  },
]

const unwatchers: WatchContractEventReturnType[] = []
let reconnecting = false

/** Decoded args from Governor Bravo ABI events */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DecodedArgs = Record<string, any>

// ─── Event Parsing ──────────────────────────────────────────────────

function parseProposalCreated(
  eventLog: Log,
  args: DecodedArgs,
  protocol: GovernanceProtocol,
): ProposalCreatedEvent {
  return {
    type: 'proposal_created',
    protocol,
    blockNumber: eventLog.blockNumber!,
    transactionHash: eventLog.transactionHash!,
    logIndex: eventLog.logIndex!,
    removed: eventLog.removed ?? false,
    proposalId: args.id,
    proposer: args.proposer,
    targets: [...args.targets],
    values: [...args.values],
    signatures: [...args.signatures],
    calldatas: [...args.calldatas],
    startBlock: args.startBlock,
    endBlock: args.endBlock,
    description: args.description,
  }
}

function parseVoteCast(
  eventLog: Log,
  args: DecodedArgs,
  protocol: GovernanceProtocol,
): VoteCastEvent {
  return {
    type: 'vote_cast',
    protocol,
    blockNumber: eventLog.blockNumber!,
    transactionHash: eventLog.transactionHash!,
    logIndex: eventLog.logIndex!,
    removed: eventLog.removed ?? false,
    proposalId: args.proposalId,
    voter: args.voter,
    support: Number(args.support),
    votes: args.votes,
    reason: args.reason,
  }
}

function parseProposalQueued(
  eventLog: Log,
  args: DecodedArgs,
  protocol: GovernanceProtocol,
): ProposalQueuedEvent {
  return {
    type: 'proposal_queued',
    protocol,
    blockNumber: eventLog.blockNumber!,
    transactionHash: eventLog.transactionHash!,
    logIndex: eventLog.logIndex!,
    removed: eventLog.removed ?? false,
    proposalId: args.id,
    eta: args.eta,
  }
}

function parseProposalExecuted(
  eventLog: Log,
  args: DecodedArgs,
  protocol: GovernanceProtocol,
): ProposalExecutedEvent {
  return {
    type: 'proposal_executed',
    protocol,
    blockNumber: eventLog.blockNumber!,
    transactionHash: eventLog.transactionHash!,
    logIndex: eventLog.logIndex!,
    removed: eventLog.removed ?? false,
    proposalId: args.id,
  }
}

function parseProposalCanceled(
  eventLog: Log,
  args: DecodedArgs,
  protocol: GovernanceProtocol,
): ProposalCanceledEvent {
  return {
    type: 'proposal_canceled',
    protocol,
    blockNumber: eventLog.blockNumber!,
    transactionHash: eventLog.transactionHash!,
    logIndex: eventLog.logIndex!,
    removed: eventLog.removed ?? false,
    proposalId: args.id,
  }
}

// ─── Log Processing ─────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function processGovernanceLog(eventLog: any, protocol: GovernanceProtocol): void {
  const txHash = eventLog.transactionHash
  const logIndex = eventLog.logIndex
  const blockNumber = eventLog.blockNumber

  // Null safety checks
  if (!txHash || logIndex === undefined || logIndex === null || !blockNumber) {
    log.warn({ eventLog }, 'Incomplete event log — skipping')
    return
  }

  // Handle chain reorg
  if (eventLog.removed) {
    log.warn({ txHash, protocol }, 'Reorg detected — rolling back event')
    rollbackEvent(txHash, logIndex)
    return
  }

  // Dedup
  if (isEventProcessed(txHash, logIndex)) return

  const eventName = eventLog.eventName as string
  let govEvent

  switch (eventName) {
    case 'ProposalCreated':
      govEvent = parseProposalCreated(eventLog, eventLog.args, protocol)
      eventBus.emit('governance:proposal', govEvent)
      break
    case 'VoteCast':
      govEvent = parseVoteCast(eventLog, eventLog.args, protocol)
      eventBus.emit('governance:vote', govEvent)
      break
    case 'ProposalQueued':
      govEvent = parseProposalQueued(eventLog, eventLog.args, protocol)
      eventBus.emit('governance:queued', govEvent)
      break
    case 'ProposalExecuted':
      govEvent = parseProposalExecuted(eventLog, eventLog.args, protocol)
      eventBus.emit('governance:executed', govEvent)
      break
    case 'ProposalCanceled':
      govEvent = parseProposalCanceled(eventLog, eventLog.args, protocol)
      eventBus.emit('governance:canceled', govEvent)
      break
    default:
      log.debug({ eventName }, 'Unhandled Governor Bravo event')
      return
  }

  markEventProcessed(BigInt(blockNumber), txHash, logIndex, eventName, protocol)
  log.info({ protocol, eventName, proposalId: govEvent.proposalId.toString() }, 'Processed governance event')
}

// ─── Backfill ───────────────────────────────────────────────────────

async function backfill(gov: GovernorBravoConfig): Promise<void> {
  const fromBlock = getLastProcessedBlock(gov.address)
  if (fromBlock === 0n) {
    log.info({ protocol: gov.label }, 'No cursor found, starting from current block')
    const current = await getCurrentBlock()
    setLastProcessedBlock(gov.address, current)
    return
  }

  const currentBlock = await getCurrentBlock()
  if (fromBlock >= currentBlock) return

  log.info(
    { protocol: gov.label, fromBlock: fromBlock.toString(), toBlock: currentBlock.toString() },
    'Backfilling governance events',
  )

  const logs = await getPaginatedLogs({
    address: gov.address,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    events: governorBravoAbi.filter((item) => item.type === 'event') as any,
    fromBlock: fromBlock + 1n,
    toBlock: currentBlock,
  })

  for (const eventLog of logs) {
    processGovernanceLog(eventLog, gov.protocol)
  }

  setLastProcessedBlock(gov.address, currentBlock)
  log.info({ protocol: gov.label, eventsProcessed: logs.length }, 'Backfill complete')
}

// ─── Real-time Subscription ─────────────────────────────────────────

function subscribe(gov: GovernorBravoConfig): void {
  const client = getReadClient()

  const eventNames = ['ProposalCreated', 'VoteCast', 'ProposalQueued', 'ProposalExecuted', 'ProposalCanceled'] as const

  for (const eventName of eventNames) {
    const unwatch = client.watchContractEvent({
      address: gov.address,
      abi: governorBravoAbi,
      eventName,
      pollingInterval: config.pollingIntervalMs,
      onLogs: (logs) => {
        for (const eventLog of logs) {
          processGovernanceLog(eventLog, gov.protocol)
          if (!eventLog.removed && eventLog.blockNumber) {
            setLastProcessedBlock(gov.address, eventLog.blockNumber)
          }
        }
      },
      onError: (error) => {
        const isSocketClosed = error?.name === 'SocketClosedError' ||
          (error?.message ?? '').includes('socket has been closed')
        if (isSocketClosed) {
          log.warn({ protocol: gov.label, eventName }, 'WSS disconnected — scheduling reconnect with backfill in 10s')
        } else {
          log.error({ err: error, protocol: gov.label, eventName }, 'Subscription error')
        }
        if (!reconnecting) {
          reconnecting = true
          setTimeout(() => {
            reconnecting = false
            startGovernorBravoMonitor().catch((err) => log.error({ err }, 'Governor Bravo reconnect failed'))
          }, 10_000)
        }
      },
    })

    unwatchers.push(unwatch)
  }

  log.info({ protocol: gov.label, address: gov.address }, 'Subscribed to Governor Bravo events')
}

// ─── Active Proposal Backfill ────────────────────────────────────────
// On startup: fetch recent proposals from chain, analyze any that are still
// Active/Succeeded/Queued but not yet in the DB (e.g. from before a restart).
// This populates cachedAnalyses so stage-transition re-entry signals can still fire.

// Governor Bravo proposal states
const PROPOSAL_STATE_ACTIVE = 1
const PROPOSAL_STATE_SUCCEEDED = 4
const PROPOSAL_STATE_QUEUED = 5

async function backfillActiveProposals(gov: GovernorBravoConfig): Promise<void> {
  const client = getReadClient()

  const rawProposalCount = await client.readContract({
    address: gov.address,
    abi: governorBravoAbi,
    functionName: 'proposalCount',
  })
  // Defensive: readContract may return undefined on RPC edge cases; BigInt(undefined) throws
  const proposalCount: bigint = rawProposalCount != null ? BigInt(rawProposalCount as bigint | number) : 0n

  if (proposalCount === 0n) return

  // Fetch ALL ProposalCreated logs from the last ~16 days in one batch.
  // This covers: votingDelay(2d) + votingPeriod(7d) + timelock(2d) + margin = ~16d.
  // We do this ONCE to build a lookup map, then iterate candidate proposal IDs.
  const currentBlock = BigInt(await getCurrentBlock())
  const SEARCH_WINDOW = 120000n // ~16 days at 12s/block

  const createdEventAbi = governorBravoAbi.filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (item: any) => item.type === 'event' && item.name === 'ProposalCreated',
  )

  const searchFrom = currentBlock > SEARCH_WINDOW ? currentBlock - SEARCH_WINDOW : 0n
  const allCreatedLogs = await getPaginatedLogs(
    {
      address: gov.address,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      events: createdEventAbi as any,
      fromBlock: searchFrom,
      toBlock: currentBlock,
    },
    10000n,
  )

  // Build a map: proposalId (string) → log
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createdLogById = new Map<string, any>()
  for (const l of allCreatedLogs) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lid = (l as any).args?.id?.toString()
    if (lid) createdLogById.set(lid, l)
  }

  if (createdLogById.size === 0) return

  const LOOK_BACK = 30n
  const startId = proposalCount > LOOK_BACK ? proposalCount - LOOK_BACK + 1n : 1n
  let backfilled = 0

  for (let id = startId; id <= proposalCount; id++) {
    const proposalKey = `${gov.protocol}:${id.toString()}`

    // Skip if already analyzed and persisted
    if (getProposal(proposalKey)) continue

    // Skip if no ProposalCreated log in our window (too old or not yet created)
    const createdLog = createdLogById.get(id.toString())
    if (!createdLog) continue

    let state: number
    try {
      state = Number(await client.readContract({
        address: gov.address,
        abi: governorBravoAbi,
        functionName: 'state',
        args: [id],
      }))
    } catch {
      continue
    }

    // Only backfill proposals that could still generate alpha
    if (state !== PROPOSAL_STATE_ACTIVE && state !== PROPOSAL_STATE_SUCCEEDED && state !== PROPOSAL_STATE_QUEUED) continue

    // Emit as proposal_created — wireAnalysisPipeline handler will analyze and persist to DB
    const event = parseProposalCreated(createdLog, createdLog.args, gov.protocol)
    eventBus.emit('governance:proposal', event)
    backfilled++
    log.info(
      { protocol: gov.label, proposalId: id.toString(), state },
      'Active proposal backfilled from on-chain',
    )
  }

  if (backfilled > 0) {
    log.info({ protocol: gov.label, backfilled }, 'Active proposal backfill complete')
  }
}

// ─── Public API ─────────────────────────────────────────────────────

export async function startGovernorBravoMonitor(): Promise<void> {
  // Stop existing monitors first to prevent memory leaks
  if (unwatchers.length > 0) {
    log.debug('Stopping existing Governor Bravo monitors before restart')
    stopGovernorBravoMonitor()
  }

  for (const gov of GOVERNORS) {
    try {
      await backfill(gov)
      await backfillActiveProposals(gov)
      subscribe(gov)
    } catch (err) {
      log.error({ err, protocol: gov.label }, 'Failed to start Governor Bravo monitor')
    }
  }
  log.info('Governor Bravo monitor started')
}

export function stopGovernorBravoMonitor(): void {
  for (const unwatch of unwatchers) {
    unwatch()
  }
  unwatchers.length = 0
  log.info('Governor Bravo monitor stopped')
}
