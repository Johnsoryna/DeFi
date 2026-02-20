/**
 * Aave V3 Governance monitor.
 * Watches GovernanceCore for proposal lifecycle events.
 * Watches VotingMachine for vote events.
 */
import { type WatchContractEventReturnType } from 'viem'
import { getReadClient, getPaginatedLogs, getCurrentBlock } from '../clients/rpc.js'
import { aaveGovernanceCoreAbi } from '../config/abis/aaveGovernanceCore.js'
import { aaveVotingMachineAbi } from '../config/abis/aaveVotingMachine.js'
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
  ProposalCreatedEvent,
  ProposalQueuedEvent,
  ProposalExecutedEvent,
  VoteCastEvent,
} from '../types/governance.js'

const log = createLogger('aave-gov')

const GOVERNANCE_CORE = GOVERNANCE.aaveGovernanceCore as `0x${string}`
const VOTING_MACHINE = GOVERNANCE.aaveVotingMachine as `0x${string}`

const unwatchers: WatchContractEventReturnType[] = []

// ─── Event Processing ───────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function processGovernanceCoreLog(eventLog: any): void {
  const txHash = eventLog.transactionHash
  const logIndex = eventLog.logIndex
  const blockNumber = eventLog.blockNumber

  // Null safety checks
  if (!txHash || logIndex === undefined || logIndex === null || !blockNumber) {
    log.warn({ eventLog }, 'Incomplete Aave event log — skipping')
    return
  }

  if (eventLog.removed) {
    log.warn({ txHash }, 'Reorg detected — rolling back Aave event')
    rollbackEvent(txHash, logIndex)
    return
  }

  if (isEventProcessed(txHash, logIndex)) return

  const eventName = eventLog.eventName as string
  const args = eventLog.args

  switch (eventName) {
    case 'ProposalCreated': {
      const event: ProposalCreatedEvent = {
        type: 'proposal_created',
        protocol: 'aave',
        blockNumber: BigInt(blockNumber),
        transactionHash: txHash,
        logIndex,
        removed: false,
        proposalId: args.proposalId,
        proposer: args.creator,
        targets: [],
        values: [],
        signatures: [],
        calldatas: [],
        description: `Aave proposal ${args.proposalId} (access level ${args.accessLevel})`,
      }
      eventBus.emit('governance:proposal', event)
      break
    }
    case 'ProposalQueued': {
      const event: ProposalQueuedEvent = {
        type: 'proposal_queued',
        protocol: 'aave',
        blockNumber: BigInt(blockNumber),
        transactionHash: txHash,
        logIndex,
        removed: false,
        proposalId: args.proposalId,
        votesFor: args.votesFor,
        votesAgainst: args.votesAgainst,
      }
      eventBus.emit('governance:queued', event)
      break
    }
    case 'ProposalExecuted': {
      const event: ProposalExecutedEvent = {
        type: 'proposal_executed',
        protocol: 'aave',
        blockNumber: BigInt(blockNumber),
        transactionHash: txHash,
        logIndex,
        removed: false,
        proposalId: args.proposalId,
      }
      eventBus.emit('governance:executed', event)
      break
    }
    case 'VotingActivated': {
      log.info({ proposalId: args.proposalId?.toString() }, 'Aave voting activated')
      break
    }
    default:
      return
  }

  markEventProcessed(BigInt(blockNumber), txHash, logIndex, eventName, 'aave')
  log.info({ eventName, proposalId: args.proposalId?.toString() }, 'Processed Aave governance event')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function processVotingMachineLog(eventLog: any): void {
  const txHash = eventLog.transactionHash
  const logIndex = eventLog.logIndex
  const blockNumber = eventLog.blockNumber

  // Null safety checks
  if (!txHash || logIndex === undefined || logIndex === null || !blockNumber) {
    log.warn({ eventLog }, 'Incomplete Aave voting event log — skipping')
    return
  }

  if (eventLog.removed) {
    rollbackEvent(txHash, logIndex)
    return
  }

  if (isEventProcessed(txHash, logIndex)) return

  const args = eventLog.args
  // Handle support as either boolean or number
  const support = typeof args.support === 'boolean' ? (args.support ? 1 : 0) : Number(args.support)
  
  const event: VoteCastEvent = {
    type: 'vote_cast',
    protocol: 'aave',
    blockNumber: BigInt(blockNumber),
    transactionHash: txHash,
    logIndex,
    removed: false,
    proposalId: args.proposalId,
    voter: args.voter,
    support,
    votes: args.votingPower,
  }

  eventBus.emit('governance:vote', event)
  markEventProcessed(BigInt(blockNumber), txHash, logIndex, 'VoteEmitted', 'aave')
}

// ─── Backfill ───────────────────────────────────────────────────────

async function backfillContract(
  address: `0x${string}`,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  abi: readonly any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  processor: (log: any) => void,
  label: string,
): Promise<void> {
  const fromBlock = getLastProcessedBlock(address)
  if (fromBlock === 0n) {
    const current = await getCurrentBlock()
    setLastProcessedBlock(address, current)
    return
  }

  const currentBlock = await getCurrentBlock()
  if (fromBlock >= currentBlock) return

  log.info({ label, fromBlock: fromBlock.toString(), toBlock: currentBlock.toString() }, 'Backfilling')

  const logs = await getPaginatedLogs({
    address,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    events: abi.filter((item) => item.type === 'event') as any,
    fromBlock: fromBlock + 1n,
    toBlock: currentBlock,
  })

  for (const eventLog of logs) {
    processor(eventLog)
  }

  setLastProcessedBlock(address, currentBlock)
  log.info({ label, eventsProcessed: logs.length }, 'Backfill complete')
}

// ─── Subscriptions ──────────────────────────────────────────────────

function subscribeGovernanceCore(): void {
  const client = getReadClient()

  for (const eventName of ['ProposalCreated', 'VotingActivated', 'ProposalQueued', 'ProposalExecuted'] as const) {
    const unwatch = client.watchContractEvent({
      address: GOVERNANCE_CORE,
      abi: aaveGovernanceCoreAbi,
      eventName,
      pollingInterval: config.pollingIntervalMs,
      onLogs: (logs) => {
        for (const eventLog of logs) {
          processGovernanceCoreLog(eventLog)
          if (!eventLog.removed && eventLog.blockNumber) {
            setLastProcessedBlock(GOVERNANCE_CORE, eventLog.blockNumber)
          }
        }
      },
      onError: (error) => {
        const isSocketClosed = error?.name === 'SocketClosedError' ||
          (error?.message ?? '').includes('socket has been closed')
        if (isSocketClosed) {
          log.warn({ eventName }, 'WSS disconnected — will auto-recover via HTTP polling')
        } else {
          log.error({ err: error, eventName }, 'GovernanceCore subscription error')
        }
      },
    })
    unwatchers.push(unwatch)
  }

  log.info('Subscribed to Aave GovernanceCore events')
}

function subscribeVotingMachine(): void {
  const client = getReadClient()

  const unwatch = client.watchContractEvent({
    address: VOTING_MACHINE,
    abi: aaveVotingMachineAbi,
    eventName: 'VoteEmitted',
    pollingInterval: config.pollingIntervalMs,
    onLogs: (logs) => {
      for (const eventLog of logs) {
        processVotingMachineLog(eventLog)
        if (!eventLog.removed && eventLog.blockNumber) {
          setLastProcessedBlock(VOTING_MACHINE, eventLog.blockNumber)
        }
      }
    },
    onError: (error) => {
      const isSocketClosed = error?.name === 'SocketClosedError' ||
        (error?.message ?? '').includes('socket has been closed')
      if (isSocketClosed) {
        log.warn('VotingMachine WSS disconnected — will auto-recover via HTTP polling')
      } else {
        log.error({ err: error }, 'VotingMachine subscription error')
      }
    },
  })

  unwatchers.push(unwatch)
  log.info('Subscribed to Aave VotingMachine events')
}

// ─── Public API ─────────────────────────────────────────────────────

export async function startAaveGovMonitor(): Promise<void> {
  // Stop existing monitors first to prevent memory leaks
  if (unwatchers.length > 0) {
    log.debug('Stopping existing Aave monitors before restart')
    stopAaveGovMonitor()
  }

  try {
    await backfillContract(GOVERNANCE_CORE, aaveGovernanceCoreAbi, processGovernanceCoreLog, 'GovernanceCore')
    await backfillContract(VOTING_MACHINE, aaveVotingMachineAbi, processVotingMachineLog, 'VotingMachine')
    subscribeGovernanceCore()
    subscribeVotingMachine()
    log.info('Aave governance monitor started')
  } catch (err) {
    log.error({ err }, 'Failed to start Aave governance monitor')
    throw err
  }
}

export function stopAaveGovMonitor(): void {
  for (const unwatch of unwatchers) {
    unwatch()
  }
  unwatchers.length = 0
  log.info('Aave governance monitor stopped')
}
