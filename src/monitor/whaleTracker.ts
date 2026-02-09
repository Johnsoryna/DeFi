/**
 * Whale delegation tracker.
 * Monitors DelegateChanged and DelegateVotesChanged events on governance tokens.
 * Maintains an in-memory map of delegate → voting power.
 */
import { type WatchContractEventReturnType, formatUnits } from 'viem'
import { getReadClient, getPaginatedLogs, getCurrentBlock } from '../clients/rpc.js'
import { erc20DelegationAbi } from '../config/abis/erc20Delegation.js'
import { DELEGATION_TOKEN_ADDRESSES, TOKENS } from '../config/addresses.js'
import { eventBus } from '../lib/eventBus.js'
import { createLogger } from '../lib/logger.js'
import {
  getLastProcessedBlock,
  setLastProcessedBlock,
  isEventProcessed,
  markEventProcessed,
} from '../lib/store.js'
import { config } from '../config/index.js'
import type { DelegationChangeEvent, DelegateVotesChangedEvent } from '../types/governance.js'

const log = createLogger('whale-tracker')

const unwatchers: WatchContractEventReturnType[] = []

// ─── In-Memory Delegate Power Map ───────────────────────────────────

/** Map: tokenAddress → (delegateAddress → votingPower) */
const delegatePower = new Map<string, Map<string, bigint>>()

/** Top N delegates to track for significant changes */
const TOP_N_DELEGATES = 50
const SIGNIFICANT_CHANGE_PCT = 5 // 5% change triggers alert

function getTokenPowerMap(token: string): Map<string, bigint> {
  const key = token.toLowerCase()
  if (!delegatePower.has(key)) {
    delegatePower.set(key, new Map())
  }
  return delegatePower.get(key)!
}

function tokenAddressToSymbol(address: string): string {
  const addr = address.toLowerCase()
  for (const [symbol, tokenAddr] of Object.entries(TOKENS)) {
    if (tokenAddr.toLowerCase() === addr) return symbol
  }
  return address.slice(0, 10)
}

// ─── Event Processing ───────────────────────────────────────────────

function processDelegateChanged(eventLog: any, tokenAddress: string): void {
  const txHash = eventLog.transactionHash
  const logIndex = eventLog.logIndex
  if (isEventProcessed(txHash, logIndex)) return

  const args = eventLog.args
  const event: DelegationChangeEvent = {
    type: 'delegation_change',
    protocol: 'compound', // Generic — protocol determined by token
    blockNumber: eventLog.blockNumber!,
    transactionHash: txHash,
    logIndex,
    removed: eventLog.removed ?? false,
    token: tokenAddress,
    delegator: args.delegator,
    fromDelegate: args.fromDelegate,
    toDelegate: args.toDelegate,
  }

  eventBus.emit('whale:delegation', event)
  markEventProcessed(eventLog.blockNumber, txHash, logIndex, 'DelegateChanged', tokenAddressToSymbol(tokenAddress))

  log.debug(
    { token: tokenAddressToSymbol(tokenAddress), from: args.fromDelegate, to: args.toDelegate },
    'Delegation changed',
  )
}

function processDelegateVotesChanged(eventLog: any, tokenAddress: string): void {
  const txHash = eventLog.transactionHash
  const logIndex = eventLog.logIndex
  if (isEventProcessed(txHash, logIndex)) return

  const args = eventLog.args
  const powerMap = getTokenPowerMap(tokenAddress)
  const delegate = args.delegate.toLowerCase()
  const oldPower = args.previousBalance as bigint
  const newPower = args.newBalance as bigint

  powerMap.set(delegate, newPower)

  // Check if this is a significant change for a top delegate
  if (oldPower > 0n) {
    const changePct = Number(((newPower - oldPower) * 10000n) / oldPower) / 100
    if (Math.abs(changePct) >= SIGNIFICANT_CHANGE_PCT) {
      const event: DelegateVotesChangedEvent = {
        type: 'delegate_votes_changed',
        protocol: 'compound', // Generic
        blockNumber: eventLog.blockNumber!,
        transactionHash: txHash,
        logIndex,
        removed: eventLog.removed ?? false,
        token: tokenAddress,
        delegate: args.delegate,
        previousBalance: oldPower,
        newBalance: newPower,
      }

      eventBus.emit('whale:delegation', event)
      log.info(
        {
          token: tokenAddressToSymbol(tokenAddress),
          delegate: args.delegate,
          changePct: changePct.toFixed(2),
          newPower: formatUnits(newPower, 18),
        },
        'Significant delegation power change',
      )
    }
  }

  markEventProcessed(eventLog.blockNumber, txHash, logIndex, 'DelegateVotesChanged', tokenAddressToSymbol(tokenAddress))
}

// ─── Subscriptions ──────────────────────────────────────────────────

function subscribeToken(tokenAddress: `0x${string}`): void {
  const client = getReadClient()

  const unwatchChanged = client.watchContractEvent({
    address: tokenAddress,
    abi: erc20DelegationAbi,
    eventName: 'DelegateChanged',
    pollingInterval: config.pollingIntervalMs,
    onLogs: (logs) => {
      for (const eventLog of logs) {
        processDelegateChanged(eventLog, tokenAddress)
        if (!eventLog.removed && eventLog.blockNumber) {
          setLastProcessedBlock(tokenAddress, eventLog.blockNumber)
        }
      }
    },
    onError: (error) => {
      log.error({ err: error, token: tokenAddressToSymbol(tokenAddress) }, 'DelegateChanged subscription error')
    },
  })

  const unwatchVotes = client.watchContractEvent({
    address: tokenAddress,
    abi: erc20DelegationAbi,
    eventName: 'DelegateVotesChanged',
    pollingInterval: config.pollingIntervalMs,
    onLogs: (logs) => {
      for (const eventLog of logs) {
        processDelegateVotesChanged(eventLog, tokenAddress)
      }
    },
    onError: (error) => {
      log.error({ err: error, token: tokenAddressToSymbol(tokenAddress) }, 'DelegateVotesChanged subscription error')
    },
  })

  unwatchers.push(unwatchChanged, unwatchVotes)
  log.info({ token: tokenAddressToSymbol(tokenAddress), address: tokenAddress }, 'Subscribed to delegation events')
}

// ─── Bootstrap ──────────────────────────────────────────────────────

async function bootstrapToken(tokenAddress: `0x${string}`): Promise<void> {
  const fromBlock = getLastProcessedBlock(tokenAddress)
  if (fromBlock === 0n) {
    // First run: just record current block (full backfill would be very expensive)
    const current = await getCurrentBlock()
    setLastProcessedBlock(tokenAddress, current)
    log.info({ token: tokenAddressToSymbol(tokenAddress) }, 'Initialized block cursor (no historical backfill)')
    return
  }

  const currentBlock = await getCurrentBlock()
  if (fromBlock >= currentBlock) return

  log.info(
    { token: tokenAddressToSymbol(tokenAddress), fromBlock: fromBlock.toString() },
    'Backfilling delegation events',
  )

  const logs = await getPaginatedLogs({
    address: tokenAddress,
    events: erc20DelegationAbi.filter((item) => item.type === 'event') as any,
    fromBlock: fromBlock + 1n,
    toBlock: currentBlock,
  })

  for (const eventLog of logs) {
    const eventName = (eventLog as any).eventName as string
    if (eventName === 'DelegateChanged') {
      processDelegateChanged(eventLog, tokenAddress)
    } else if (eventName === 'DelegateVotesChanged') {
      processDelegateVotesChanged(eventLog, tokenAddress)
    }
  }

  setLastProcessedBlock(tokenAddress, currentBlock)
}

// ─── Public API ─────────────────────────────────────────────────────

export async function startWhaleTracker(): Promise<void> {
  for (const addr of DELEGATION_TOKEN_ADDRESSES) {
    await bootstrapToken(addr as `0x${string}`)
    subscribeToken(addr as `0x${string}`)
  }
  log.info('Whale delegation tracker started')
}

export function stopWhaleTracker(): void {
  for (const unwatch of unwatchers) {
    unwatch()
  }
  unwatchers.length = 0
  log.info('Whale delegation tracker stopped')
}

/**
 * Get the top N delegates by voting power for a given token.
 */
export function getTopDelegates(
  tokenAddress: string,
  n: number = TOP_N_DELEGATES,
): Array<{ delegate: string; power: bigint }> {
  const powerMap = getTokenPowerMap(tokenAddress)
  return [...powerMap.entries()]
    .map(([delegate, power]) => ({ delegate, power }))
    .sort((a, b) => (b.power > a.power ? 1 : -1))
    .slice(0, n)
}
