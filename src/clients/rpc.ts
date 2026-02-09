/**
 * Viem RPC client with fallback transport.
 * Primary: Alchemy WSS → Fallback: PublicNode WSS → Cloudflare HTTP.
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
  type Chain,
  type Log,
  type GetLogsParameters,
  type WatchContractEventReturnType,
} from 'viem'
import { mainnet } from 'viem/chains'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { config, getAlchemyHttpUrl, getAlchemyWssUrl } from '../config/index.js'
import { createLogger } from '../lib/logger.js'
import { withRetry } from '../lib/retry.js'

const log = createLogger('rpc')

// ─── Transport Configuration ────────────────────────────────────────

function buildReadTransports(): Transport[] {
  const transports: Transport[] = []

  const alchemyWss = getAlchemyWssUrl()
  if (alchemyWss) {
    transports.push(webSocket(alchemyWss, { retryCount: 3 }))
    log.info('Added Alchemy WSS transport')
  }

  transports.push(webSocket(config.publicNodeWss, { retryCount: 3 }))
  log.info('Added PublicNode WSS transport')

  const alchemyHttp = getAlchemyHttpUrl()
  if (alchemyHttp) {
    transports.push(http(alchemyHttp, { retryCount: 3 }))
  }

  transports.push(http(config.publicNodeHttp, { retryCount: 3 }))
  transports.push(http(config.cloudflareHttp, { retryCount: 2 }))
  log.info('Added HTTP fallback transports')

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
      transport: fallback(transports, { rank: true }),
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
 */
export async function getPaginatedLogs(
  params: Omit<GetLogsParameters, 'fromBlock' | 'toBlock'> & {
    fromBlock: bigint
    toBlock: bigint
  },
): Promise<Log[]> {
  const client = getReadClient()
  const allLogs: Log[] = []

  for (let start = params.fromBlock; start <= params.toBlock; start += MAX_BLOCK_RANGE) {
    const end =
      start + MAX_BLOCK_RANGE - 1n > params.toBlock
        ? params.toBlock
        : start + MAX_BLOCK_RANGE - 1n

    const logs = await withRetry(
      () => {
        const { fromBlock: _fb, toBlock: _tb, ...rest } = params
        return client.getLogs({
          ...rest,
          fromBlock: start,
          toBlock: end,
        } as any)
      },
      `getLogs ${start}-${end}`,
      { maxRetries: 3, baseDelayMs: 2000 },
    )

    allLogs.push(...logs)
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
