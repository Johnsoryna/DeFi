/**
 * Viem RPC client with fallback transport.
 *
 * TRANSPORT PRIORITY (free-tier optimized):
 *   1. PublicNode WSS   — free, no documented limit, low latency
 *   2. PublicNode HTTP   — free, no documented limit
 *   3. Cloudflare HTTP   — free, 500K requests/month
 *   4. Alchemy HTTP      — LAST RESORT (30M CU/month free tier)
 *
 * Alchemy is intentionally placed LAST to minimize CU consumption.
 * With rank:false the order above is respected strictly as a fallback chain.
 * Separate write client through Flashbots Protect for MEV protection.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  webSocket,
  fallback,
  type PublicClient,
  type WalletClient,
  type Transport,
  type Log,
  type GetLogsParameters,
} from 'viem'
import { mainnet } from 'viem/chains'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { config, getAlchemyHttpUrl } from '../config/index.js'
import { createLogger } from '../lib/logger.js'
import { withRetry } from '../lib/retry.js'

const log = createLogger('rpc')

// ─── Transport Configuration ────────────────────────────────────────

/** Skip WSS transport (avoids noisy ErrorEvents during batch data collection) */
let httpOnly = false
export function setHttpOnlyMode(enabled: boolean): void { httpOnly = enabled }

function buildReadTransports(): Transport[] {
  const transports: Transport[] = []

  // 1. FREE providers first — no usage limits
  if (!httpOnly) {
    transports.push(webSocket(config.publicNodeWss, { retryCount: 3 }))
    log.info('Added PublicNode WSS transport (primary)')
  }

  transports.push(http(config.publicNodeHttp, { retryCount: 3 }))
  log.info('Added PublicNode HTTP transport')

  // Cloudflare Ethereum Gateway: 500K requests/month free tier.
  // Only used when both PublicNode endpoints fail — minimal real usage.
  transports.push(http(config.cloudflareHttp, { retryCount: 1 }))
  log.info('Added Cloudflare HTTP transport (500K req/month free tier)')

  // 2. Alchemy LAST — 30M CU/month free tier, only used when free providers fail
  const alchemyHttp = getAlchemyHttpUrl()
  if (alchemyHttp) {
    transports.push(http(alchemyHttp, { retryCount: 2 }))
    log.info('Added Alchemy HTTP transport (last-resort fallback, 30M CU/month)')
  }

  return transports
}

// ─── Client Singletons ──────────────────────────────────────────────

let readClient: PublicClient | null = null
let writeClient: WalletClient | null = null
let walletAccount: PrivateKeyAccount | null = null

/**
 * Get the read-only public client with fallback transport.
 */
export function getReadClient(): PublicClient {
  if (!readClient) {
    const transports = buildReadTransports()
    readClient = createPublicClient({
      chain: mainnet,
      // rank:false = strict fallback order (free providers first, Alchemy last)
      // With rank:true Viem would auto-promote Alchemy to primary due to lower latency
      transport: fallback(transports, { rank: false }),
      batch: {
        multicall: true,
      },
    })
    log.info('Read client initialized')
  }
  return readClient
}

/**
 * Get the wallet client for sending transactions through Flashbots Protect.
 * Requires ETH_PRIVATE_KEY in env.
 */
export function getWriteClient(): WalletClient {
  if (!writeClient) {
    if (!config.ethPrivateKey) {
      throw new Error('ETH_PRIVATE_KEY required for write operations')
    }

    walletAccount = privateKeyToAccount(config.ethPrivateKey as `0x${string}`)

    writeClient = createWalletClient({
      account: walletAccount,
      chain: mainnet,
      transport: http(config.flashbotsRpc),
    })

    log.info(
      { address: walletAccount.address, rpc: config.flashbotsRpc },
      'Write client initialized (Flashbots Protect)',
    )
  }
  return writeClient
}

/**
 * Get the wallet account address.
 */
export function getWalletAddress(): string {
  if (!walletAccount) {
    if (!config.ethPrivateKey) {
      throw new Error('ETH_PRIVATE_KEY required')
    }
    walletAccount = privateKeyToAccount(config.ethPrivateKey as `0x${string}`)
  }
  return walletAccount.address
}

// ─── Helper: Paginated getLogs ──────────────────────────────────────

const MAX_BLOCK_RANGE = 2000n

/**
 * Fetch logs with automatic block range pagination.
 * Most free RPCs limit getLogs to 2k-10k block ranges.
 *
 * @param chunkSize  Override the default 2000-block chunk size.
 *                   For historical backtest collection use 50_000n (governance events are rare).
 *                   If an RPC rejects with "range too wide", the chunk is automatically halved.
 * @param onProgress Optional callback called after each chunk: (processedBlocks, totalBlocks)
 */
export async function getPaginatedLogs(
  params: Omit<GetLogsParameters, 'fromBlock' | 'toBlock'> & {
    fromBlock: bigint
    toBlock: bigint
  },
  chunkSize: bigint = MAX_BLOCK_RANGE,
  onProgress?: (processedBlocks: bigint, totalBlocks: bigint) => void,
): Promise<Log[]> {
  const client = getReadClient()
  const allLogs: Log[] = []
  const totalBlocks = params.toBlock - params.fromBlock
  let currentChunk = chunkSize

  for (let start = params.fromBlock; start <= params.toBlock; ) {
    const end =
      start + currentChunk - 1n > params.toBlock
        ? params.toBlock
        : start + currentChunk - 1n

    try {
      const logs = await withRetry(
        () => {
          const { fromBlock: _fb, toBlock: _tb, ...rest } = params
          return client.getLogs({
            ...rest,
            fromBlock: start,
            toBlock: end,
          } as Parameters<typeof client.getLogs>[0])
        },
        `getLogs ${start}-${end}`,
        { maxRetries: 3, baseDelayMs: 2000 },
      )

      allLogs.push(...logs)
      start = end + 1n

      // Report progress
      if (onProgress) {
        const processed = start - params.fromBlock
        onProgress(processed > totalBlocks ? totalBlocks : processed, totalBlocks)
      }
    } catch (err) {
      // If RPC says range is too wide, halve the chunk size and retry
      const msg = err instanceof Error ? err.message : String(err)
      if (
        currentChunk > 1n &&
        (msg.includes('range') || msg.includes('too many') || msg.includes('limit') || msg.includes('10000'))
      ) {
        currentChunk = currentChunk / 2n
        log.warn({ newChunkSize: currentChunk.toString() }, 'Reducing chunk size due to RPC range limit')
        continue // retry same start with smaller chunk
      }
      throw err
    }
  }

  return allLogs
}

/**
 * Get the current block number with retry.
 */
export async function getCurrentBlock(): Promise<bigint> {
  return withRetry(
    () => getReadClient().getBlockNumber(),
    'getBlockNumber',
  )
}
