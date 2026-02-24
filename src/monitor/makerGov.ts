/**
 * MakerDAO/Sky governance monitor.
 * DSChief uses anonymous DSNote events where topic0 = function selector (padded).
 * Also watches for the non-anonymous Etch event.
 *
 * GOVERNANCE MIGRATION (May 2025):
 * MKR has been retired as the governance token. SKY is now the exclusive
 * governance token (1:24,000 MKR→SKY conversion, penalty +1% every 3 months
 * since Sep 2025). The governance portal is now at vote.sky.money.
 *
 * - DSChief v1.2 (0x0a3f...dDC0) is DEPRECATED — being phased out.
 * - Chief V3 (0x929d...6f9) is the ACTIVE governance contract using SKY tokens.
 *
 * Both contracts are still monitored for completeness, but new governance
 * activity will occur exclusively on the Chief V3 contract.
 */
import { type WatchEventReturnType, type WatchContractEventReturnType } from 'viem'
import { getReadClient, getPaginatedLogs, getCurrentBlock } from '../clients/rpc.js'
import { dsChiefAbi } from '../config/abis/dsChief.js'
import { GOVERNANCE } from '../config/addresses.js'
import { MAKER_DSNOTE_SELECTORS } from '../config/events.js'
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
import type { MakerDSNoteEvent } from '../types/governance.js'

const log = createLogger('maker-gov')

/** Shape of raw EVM event logs (viem Log-like object) */
interface RawEventLog {
  transactionHash?: string | null
  logIndex?: number | null
  blockNumber?: bigint | number | null
  removed?: boolean
  topics?: string[]
  data?: string
  args?: Record<string, unknown>
}

const DS_CHIEF_ADDRESSES: `0x${string}`[] = [
  GOVERNANCE.makerNewChief as `0x${string}`,     // ACTIVE — Sky Chief V3 (SKY tokens)
]

const unwatchers: (WatchEventReturnType | WatchContractEventReturnType)[] = []

// ─── Selector to Function Name Mapping ──────────────────────────────

const SELECTOR_TO_NAME: Record<string, string> = {
  [MAKER_DSNOTE_SELECTORS.lock]: 'lock',
  [MAKER_DSNOTE_SELECTORS.free]: 'free',
  [MAKER_DSNOTE_SELECTORS.voteArray]: 'vote(address[])',
  [MAKER_DSNOTE_SELECTORS.voteSlate]: 'vote(bytes32)',
  [MAKER_DSNOTE_SELECTORS.lift]: 'lift',
}

function selectorFromTopic(topic0: string): string | undefined {
  // DSNote encodes the function selector right-aligned (left-padded with zeros) in topic0.
  // The selector occupies the last 4 bytes (= last 8 hex chars) of the 32-byte topic.
  // slice(0, 10) would give the leading zeros — slice(-8) gives the actual selector bytes.
  if (!topic0 || topic0.length < 10) return undefined
  return ('0x' + topic0.slice(-8)).toLowerCase()
}

// ─── Event Processing ───────────────────────────────────────────────

function processDSNoteLog(eventLog: RawEventLog): void {
  const txHash = eventLog.transactionHash
  const logIndex = eventLog.logIndex
  const blockNumber = eventLog.blockNumber

  // Null safety checks
  if (!txHash || logIndex === undefined || logIndex === null || !blockNumber) {
    log.warn({ eventLog }, 'Incomplete Maker event log — skipping')
    return
  }

  if (eventLog.removed) {
    log.warn({ txHash }, 'Reorg — rolling back Maker event')
    rollbackEvent(txHash, logIndex)
    return
  }

  if (isEventProcessed(txHash, logIndex)) return

  const topics = eventLog.topics as string[]
  if (!topics || topics.length === 0) return

  const selector = selectorFromTopic(topics[0])
  if (!selector) return

  const functionName = SELECTOR_TO_NAME[selector]
  if (!functionName) return

  // topic1 contains the caller address (for DSNote)
  // Validate topic length before extracting address
  let caller = 'unknown'
  if (topics.length > 1 && topics[1] && topics[1].length >= 26) {
    try {
      caller = ('0x' + topics[1].slice(26)) as string
    } catch {
      log.debug({ topic: topics[1] }, 'Failed to extract caller address from topic')
    }
  }

  const event: MakerDSNoteEvent = {
    type: 'maker_dsnote',
    protocol: 'maker',
    blockNumber: BigInt(blockNumber),
    transactionHash: txHash,
    logIndex,
    removed: false,
    functionName,
    caller,
    rawData: eventLog.data ?? '0x',
  }

  eventBus.emit('governance:proposal', event)
  markEventProcessed(BigInt(blockNumber), txHash, logIndex, `maker:${functionName}`, 'maker')
  log.info({ functionName, caller }, 'Processed Maker DSNote event')
}

// ─── Etch Event (non-anonymous) ─────────────────────────────────────

function processEtchLog(eventLog: RawEventLog): void {
  const txHash = eventLog.transactionHash
  const logIndex = eventLog.logIndex ?? 0
  const blockNumber = eventLog.blockNumber != null ? BigInt(eventLog.blockNumber) : 0n

  if (eventLog.removed) {
    if (txHash) rollbackEvent(txHash)
    return
  }

  if (txHash && isEventProcessed(txHash, logIndex)) return

  const event: MakerDSNoteEvent = {
    type: 'maker_dsnote',
    protocol: 'maker',
    blockNumber,
    transactionHash: txHash ?? '0x',
    logIndex,
    removed: false,
    functionName: 'etch',
    caller: (eventLog.args?.slate as string) ?? 'unknown',
    rawData: eventLog.data ?? '0x',
  }

  eventBus.emit('governance:proposal', event)
  markEventProcessed(blockNumber, txHash ?? '0x', logIndex, 'maker:etch', 'maker')
  log.info('Processed Maker Etch event')
}

// ─── Backfill ───────────────────────────────────────────────────────

async function backfillDSNotes(address: `0x${string}`): Promise<void> {
  const fromBlock = getLastProcessedBlock(address)
  if (fromBlock === 0n) {
    const current = await getCurrentBlock()
    setLastProcessedBlock(address, current)
    return
  }

  const currentBlock = await getCurrentBlock()
  if (fromBlock >= currentBlock) return

  log.info({ address, fromBlock: fromBlock.toString() }, 'Backfilling Maker DSNote events')

  // Query raw logs with DSNote selector topics
  const logs = await getPaginatedLogs({
    address,
    fromBlock: fromBlock + 1n,
    toBlock: currentBlock,
  })

  for (const eventLog of logs) {
    const topics = eventLog.topics as string[]
    if (topics && topics.length > 0) {
      const selector = selectorFromTopic(topics[0])
      if (selector && SELECTOR_TO_NAME[selector]) {
        processDSNoteLog(eventLog)
      }
    }
  }

  setLastProcessedBlock(address, currentBlock)
}

// ─── Subscriptions ──────────────────────────────────────────────────

function subscribeDSNotes(address: `0x${string}`): void {
  const client = getReadClient()

  // Watch raw events — DSNote is anonymous so we must filter by raw topics
  const unwatch = client.watchEvent({
    address,
    pollingInterval: config.pollingIntervalMs,
    onLogs: (logs) => {
      for (const eventLog of logs) {
        processDSNoteLog(eventLog)
        if (!eventLog.removed && eventLog.blockNumber) {
          setLastProcessedBlock(address, eventLog.blockNumber)
        }
      }
    },
    onError: (error) => {
      const isSocketClosed = error?.name === 'SocketClosedError' ||
        (error?.message ?? '').includes('socket has been closed')
      if (isSocketClosed) {
        log.warn({ address }, 'DSNote WSS disconnected — will auto-recover via HTTP polling')
      } else {
        log.error({ err: error, address }, 'DSNote subscription error')
      }
    },
  })

  unwatchers.push(unwatch)

  // Also watch the non-anonymous Etch event
  const unwatchEtch = client.watchContractEvent({
    address,
    abi: dsChiefAbi,
    eventName: 'Etch',
    pollingInterval: config.pollingIntervalMs,
    onLogs: (logs) => {
      for (const eventLog of logs) {
        processEtchLog(eventLog)
      }
    },
    onError: (error) => {
      const isSocketClosed = error?.name === 'SocketClosedError' ||
        (error?.message ?? '').includes('socket has been closed')
      if (isSocketClosed) {
        log.warn('Etch WSS disconnected — will auto-recover via HTTP polling')
      } else {
        log.error({ err: error }, 'Etch subscription error')
      }
    },
  })

  unwatchers.push(unwatchEtch)
  log.info({ address }, 'Subscribed to Maker DSChief events')
}

// ─── Public API ─────────────────────────────────────────────────────

export async function startMakerGovMonitor(): Promise<void> {
  // Stop existing monitors first to prevent memory leaks
  if (unwatchers.length > 0) {
    log.debug('Stopping existing Maker monitors before restart')
    stopMakerGovMonitor()
  }

  for (const address of DS_CHIEF_ADDRESSES) {
    try {
      await backfillDSNotes(address)
      subscribeDSNotes(address)
    } catch (err) {
      log.error({ err, address }, 'Failed to start Maker monitor for address')
    }
  }
  log.info('Maker/Sky governance monitor started')
}

export function stopMakerGovMonitor(): void {
  for (const unwatch of unwatchers) {
    unwatch()
  }
  unwatchers.length = 0
  log.info('Maker/Sky governance monitor stopped')
}
