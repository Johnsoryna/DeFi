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
import { type WatchEventReturnType, type WatchContractEventReturnType, decodeAbiParameters, parseAbiParameters } from 'viem'
import { getReadClient, getPaginatedLogs, getCurrentBlock } from '../clients/rpc.js'
import { dsChiefAbi } from '../config/abis/dsChief.js'
import { GOVERNANCE } from '../config/addresses.js'
import { MAKER_DSNOTE_SELECTORS, MAKER_DSNOTE_TOPICS } from '../config/events.js'
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

const DS_CHIEF_ADDRESSES: `0x${string}`[] = [
  GOVERNANCE.makerDSChiefV12 as `0x${string}`,  // DEPRECATED — legacy MKR governance
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
  // topic0 is the selector left-padded to 32 bytes
  const selector = topic0.slice(0, 10).toLowerCase()
  return selector
}

// ─── Event Processing ───────────────────────────────────────────────

function processDSNoteLog(eventLog: any): void {
  const txHash = eventLog.transactionHash
  const logIndex = eventLog.logIndex

  if (eventLog.removed) {
    log.warn({ txHash }, 'Reorg — rolling back Maker event')
    rollbackEvent(txHash)
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
  const caller = topics.length > 1
    ? ('0x' + topics[1].slice(26)) as string
    : 'unknown'

  const event: MakerDSNoteEvent = {
    type: 'maker_dsnote',
    protocol: 'maker',
    blockNumber: eventLog.blockNumber!,
    transactionHash: txHash,
    logIndex,
    removed: false,
    functionName,
    caller,
    rawData: eventLog.data ?? '0x',
  }

  eventBus.emit('governance:proposal', event)
  markEventProcessed(eventLog.blockNumber, txHash, logIndex, `maker:${functionName}`, 'maker')
  log.info({ functionName, caller }, 'Processed Maker DSNote event')
}

// ─── Etch Event (non-anonymous) ─────────────────────────────────────

function processEtchLog(eventLog: any): void {
  const txHash = eventLog.transactionHash
  const logIndex = eventLog.logIndex

  if (eventLog.removed) {
    rollbackEvent(txHash)
    return
  }

  if (isEventProcessed(txHash, logIndex)) return

  const event: MakerDSNoteEvent = {
    type: 'maker_dsnote',
    protocol: 'maker',
    blockNumber: eventLog.blockNumber!,
    transactionHash: txHash,
    logIndex,
    removed: false,
    functionName: 'etch',
    caller: eventLog.args?.slate ?? 'unknown',
    rawData: eventLog.data ?? '0x',
  }

  eventBus.emit('governance:proposal', event)
  markEventProcessed(eventLog.blockNumber, txHash, logIndex, 'maker:etch', 'maker')
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
  const client = getReadClient()
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
      log.error({ err: error, address }, 'DSNote subscription error')
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
      log.error({ err: error }, 'Etch subscription error')
    },
  })

  unwatchers.push(unwatchEtch)
  log.info({ address }, 'Subscribed to Maker DSChief events')
}

// ─── Public API ─────────────────────────────────────────────────────

export async function startMakerGovMonitor(): Promise<void> {
  for (const address of DS_CHIEF_ADDRESSES) {
    await backfillDSNotes(address)
    subscribeDSNotes(address)
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
