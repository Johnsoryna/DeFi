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
          log.warn({ protocol: gov.label, eventName }, 'WSS disconnected — will auto-recover via HTTP polling')
        } else {
          log.error({ err: error, protocol: gov.label, eventName }, 'Subscription error')
        }
      },
    })

    unwatchers.push(unwatch)
  }

  log.info({ protocol: gov.label, address: gov.address }, 'Subscribed to Governor Bravo events')
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
