/**
 * Historical data collector for backtesting.
 * Fetches and caches governance events, prices, Snapshot proposals, and forum posts
 * into the backtest SQLite database.
 */
import type Database from 'better-sqlite3'
import { createLogger } from '../lib/logger.js'
import { sleep } from '../lib/retry.js'
import { getReadClient, getPaginatedLogs } from '../clients/rpc.js'
import { governorBravoAbi } from '../config/abis/governorBravo.js'
import { aaveGovernanceCoreAbi } from '../config/abis/aaveGovernanceCore.js'
import { aaveVotingMachineAbi } from '../config/abis/aaveVotingMachine.js'
import { GOVERNANCE, APIS } from '../config/addresses.js'
import { getAllPriceableAddresses } from './assetResolver.js'
import * as defiLlama from '../clients/defillama.js'
import { withRetry } from '../lib/retry.js'

const log = createLogger('data-collector')

// ─── Governance Events ───────────────────────────────────────────────

interface ContractConfig {
  address: `0x${string}`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  abi: readonly any[]
  label: string
}

const MONITORED_CONTRACTS: ContractConfig[] = [
  { address: GOVERNANCE.compoundGovernorBravo as `0x${string}`, abi: governorBravoAbi, label: 'Compound' },
  { address: GOVERNANCE.uniswapGovernorBravo as `0x${string}`, abi: governorBravoAbi, label: 'Uniswap' },
  { address: GOVERNANCE.aaveGovernanceCore as `0x${string}`, abi: aaveGovernanceCoreAbi, label: 'Aave Core' },
  { address: GOVERNANCE.aaveVotingMachine as `0x${string}`, abi: aaveVotingMachineAbi, label: 'Aave Voting' },
]

/**
 * Collect historical governance events from on-chain logs.
 * Resolves block timestamps for chronological replay.
 */
export async function collectGovernanceEvents(
  db: Database.Database,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<number> {
  const client = getReadClient()
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO historical_events
       (block_number, tx_hash, log_index, contract_address, event_name, args_json, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )

  // Cache of block number → timestamp
  const blockTimestamps = new Map<bigint, number>()
  let totalInserted = 0

  // Use 50K-block chunks for historical collection (governance events are rare).
  // If the RPC rejects the range, getPaginatedLogs auto-halves the chunk size.
  const BACKTEST_CHUNK_SIZE = 50_000n

  for (const contract of MONITORED_CONTRACTS) {
    const totalBlocks = toBlock - fromBlock
    log.info({
      label: contract.label,
      fromBlock: fromBlock.toString(),
      toBlock: toBlock.toString(),
      totalBlocks: totalBlocks.toString(),
      chunkSize: BACKTEST_CHUNK_SIZE.toString(),
      estimatedChunks: Math.ceil(Number(totalBlocks) / Number(BACKTEST_CHUNK_SIZE)),
    }, 'Collecting events')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events = contract.abi.filter((item: any) => item.type === 'event')
    let lastProgressLog = 0
    const logs = await getPaginatedLogs(
      {
        address: contract.address,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        events: events as any,
        fromBlock,
        toBlock,
      },
      BACKTEST_CHUNK_SIZE,
      (processed, total) => {
        const pct = Number(processed * 100n / total)
        // Log every 10% progress
        if (pct >= lastProgressLog + 10) {
          lastProgressLog = pct - (pct % 10)
          log.info({ label: contract.label, progress: `${pct}%` }, 'Event collection progress')
        }
      },
    )

    log.info({ label: contract.label, count: logs.length }, 'Fetched raw logs')

    // Resolve block timestamps: fetch a reference block, then estimate the rest.
    // Individual RPC calls per block are too slow for large event sets (4000+ events).
    const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber!))]
    if (uniqueBlocks.length > 0 && !blockTimestamps.has(uniqueBlocks[0])) {
      // Fetch ONE reference block timestamp, estimate all others via 12s/block
      const refBlock = uniqueBlocks[Math.floor(uniqueBlocks.length / 2)]
      let refTimestamp: number
      try {
        const block = await withRetry(
          () => client.getBlock({ blockNumber: refBlock }),
          `getBlock-ref-${refBlock}`,
          { maxRetries: 3, baseDelayMs: 1000 },
        )
        refTimestamp = Number(block.timestamp) * 1000
      } catch {
        // Fallback: estimate from toBlock = now
        const blocksBack = toBlock >= refBlock ? Number(toBlock - refBlock) : 0
        refTimestamp = Date.now() - blocksBack * 12000
      }

      blockTimestamps.set(refBlock, refTimestamp)
      for (const bn of uniqueBlocks) {
        if (!blockTimestamps.has(bn)) {
          // Estimate: 12 seconds per block relative to the reference
          const blockDiff = Number(bn - refBlock)
          blockTimestamps.set(bn, refTimestamp + blockDiff * 12000)
        }
      }
      log.info({ uniqueBlocks: uniqueBlocks.length, refBlock: refBlock.toString() }, 'Block timestamps estimated')
    }

    // Insert events
    const insertMany = db.transaction((eventLogs: typeof logs) => {
      for (const eventLog of eventLogs) {
        const ts = blockTimestamps.get(eventLog.blockNumber!) ?? Date.now()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const argsJson = JSON.stringify((eventLog as any).args ?? {}, (_key, val) =>
          typeof val === 'bigint' ? val.toString() : val,
        )

        try {
          // logIndex can be null for pending txs; coerce to 0 for NOT NULL constraint
          const logIdx = eventLog.logIndex ?? 0
          const result = insertStmt.run(
            Number(eventLog.blockNumber),
            eventLog.transactionHash,
            logIdx,
            contract.address.toLowerCase(),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (eventLog as any).eventName ?? 'unknown',
            argsJson,
            ts,
          )
          if (result.changes > 0) totalInserted++
        } catch (err) {
          // UNIQUE constraint — already cached (log unexpected errors)
          const msg = err instanceof Error ? err.message : String(err)
          if (!msg.includes('UNIQUE')) {
            log.warn({ err: msg, tx: eventLog.transactionHash }, 'Unexpected insert error')
          }
        }
      }
    })

    insertMany(logs)
    log.info({ label: contract.label, inserted: totalInserted }, 'Events cached')
  }

  // Store progress metadata
  db.prepare(
    `INSERT INTO collection_metadata (key, value, updated_at)
     VALUES ('events_last_block', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`,
  ).run(toBlock.toString(), toBlock.toString())

  log.info({ totalInserted }, 'Governance event collection complete')
  return totalInserted
}

// ─── Historical Prices ───────────────────────────────────────────────

/**
 * Collect historical prices at regular intervals for all known DeFi tokens.
 * Includes governance tokens AND well-known assets that appear in proposals.
 */
export async function collectPrices(
  db: Database.Database,
  from: Date,
  to: Date,
  intervalMs: number = 3600_000, // Default: hourly
): Promise<number> {
  // Collect ALL tokens: governance tokens + well-known DeFi assets (multi-chain)
  const allAssets = getAllPriceableAddresses()
  const tokens = allAssets.map(({ symbol, address, chain }) => ({
    symbol,
    coin: defiLlama.buildCoinId(chain, address),
  }))

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO historical_prices (asset, timestamp, price, source)
     VALUES (?, ?, ?, 'defillama')`,
  )

  let totalInserted = 0
  const startTs = from.getTime()
  const endTs = to.getTime()

  // Batch tokens together per DefiLlama call (all tokens at once)
  const coins = tokens.map((t) => t.coin)

  // Smart-skip: check how many tokens already have a price at each timestamp.
  // If all tokens have data, skip the API call entirely.
  const countStmt = db.prepare(
    'SELECT COUNT(*) as c FROM historical_prices WHERE timestamp = ?',
  )
  const minExpectedPrices = Math.floor(tokens.length * 0.8) // 80% threshold

  const totalSteps = Math.ceil((endTs - startTs) / intervalMs)
  let step = 0
  let skipped = 0
  let rateLimitHits = 0

  for (let ts = startTs; ts <= endTs; ts += intervalMs) {
    step++
    const timestampSec = Math.floor(ts / 1000)

    // Skip timestamps that already have most prices cached
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existing = (countStmt.get(ts) as any).c
    if (existing >= minExpectedPrices) {
      skipped++
      continue
    }

    try {
      const prices = await defiLlama.getHistoricalPrices(timestampSec, coins)
      rateLimitHits = 0 // Reset on success

      const insertBatch = db.transaction(() => {
        for (const token of tokens) {
          const priceData = prices[token.coin]
          if (!priceData) continue
          try {
            const result = insertStmt.run(token.symbol, ts, priceData.price.toString())
            if (result.changes > 0) totalInserted++
          } catch {
            // UNIQUE constraint
          }
        }
      })
      insertBatch()
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (errMsg.includes('429')) {
        rateLimitHits++
        // Exponential backoff on rate limit: 2s, 4s, 8s, 16s...
        const backoffMs = Math.min(2000 * Math.pow(2, rateLimitHits - 1), 30000)
        log.warn({ backoffMs, rateLimitHits }, 'Rate limited — backing off')
        await sleep(backoffMs)
        ts -= intervalMs // Retry this timestamp
        step--
        continue
      }
      log.warn({ timestamp: new Date(ts).toISOString(), err }, 'Failed to fetch historical prices')
    }

    // 1200ms delay to stay comfortably under DefiLlama's rate limit
    await sleep(1200)

    // Progress log every 5%
    if (step % Math.max(1, Math.floor(totalSteps / 20)) === 0) {
      const progress = ((ts - startTs) / (endTs - startTs) * 100).toFixed(1)
      log.info({ progress: `${progress}%`, prices: totalInserted, skipped, step, totalSteps }, 'Price collection progress')
    }
  }

  log.info({ skipped, totalSteps }, 'Smart-skip summary')

  db.prepare(
    `INSERT INTO collection_metadata (key, value, updated_at)
     VALUES ('prices_last_to', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`,
  ).run(to.toISOString(), to.toISOString())

  log.info({ totalInserted }, 'Price collection complete')
  return totalInserted
}

// ─── Historical Snapshot Proposals ───────────────────────────────────

/**
 * Collect historical Snapshot proposals (all states) for monitored spaces.
 */
export async function collectSnapshots(
  db: Database.Database,
  spaces: readonly string[],
  from: Date,
  to: Date,
): Promise<number> {
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO historical_snapshots
       (proposal_id, space, title, body, state, start, "end", scores_json, author, choices_json, scores_total, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  let totalInserted = 0
  const fromTs = Math.floor(from.getTime() / 1000)
  const toTs = Math.floor(to.getTime() / 1000)

  for (const space of spaces) {
    let skip = 0
    const batchSize = 100
    let hasMore = true

    while (hasMore) {
      try {
        const data = await withRetry(
          async () => {
            const res = await fetch(APIS.snapshotGraphql, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                query: `query($space: String!, $first: Int!, $skip: Int!, $start: Int!, $end: Int!) {
                  proposals(
                    first: $first,
                    skip: $skip,
                    where: { space: $space, created_gte: $start, created_lte: $end },
                    orderBy: "created", orderDirection: asc
                  ) {
                    id title body choices start end snapshot state author
                    scores scores_total
                    space { id }
                  }
                }`,
                variables: { space, first: batchSize, skip, start: fromTs, end: toTs },
              }),
            })
            if (!res.ok) throw new Error(`Snapshot API ${res.status}`)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const json = (await res.json()) as any
            return json.data?.proposals ?? []
          },
          `snapshot-collect-${space}`,
          { maxRetries: 3, baseDelayMs: 3000 },
        )

        if (data.length === 0) {
          hasMore = false
          continue
        }

        const insertBatch = db.transaction(() => {
          for (const p of data) {
            try {
              const result = insertStmt.run(
                p.id,
                space,
                p.title,
                p.body,
                p.state,
                p.start * 1000,
                p.end * 1000,
                JSON.stringify(p.scores ?? []),
                p.author ?? '',
                JSON.stringify(p.choices ?? []),
                p.scores_total ?? 0,
                p.start * 1000, // Use proposal start as created_at (closest to creation)
              )
              if (result.changes > 0) totalInserted++
            } catch {
              // UNIQUE constraint
            }
          }
        })
        insertBatch()

        skip += data.length
        if (data.length < batchSize) hasMore = false

      } catch (err) {
        log.error({ space, skip, err }, 'Failed to fetch Snapshot proposals')
        hasMore = false
      }
    }

    log.info({ space, proposals: totalInserted }, 'Snapshot collection done for space')
  }

  log.info({ totalInserted }, 'Snapshot collection complete')
  return totalInserted
}

// ─── Historical Forum Posts ──────────────────────────────────────────

/**
 * Collect historical forum topics from Discourse forums.
 */
export async function collectForumPosts(
  db: Database.Database,
  forums: Record<string, string>,
  from: Date,
  to: Date,
): Promise<number> {
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO historical_forum_posts
       (topic_id, forum_url, title, created_at, category_id, posts_count, reply_count, views)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  let totalInserted = 0

  for (const [protocol, baseUrl] of Object.entries(forums)) {
    let page = 0
    let hasMore = true

    while (hasMore) {
      try {
        const data = await withRetry(
          async () => {
            const res = await fetch(`${baseUrl}/latest.json?page=${page}`, {
              headers: { Accept: 'application/json' },
            })
            if (!res.ok) throw new Error(`Discourse ${res.status}: ${baseUrl}`)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (await res.json()) as { topic_list: { topics: any[] } }
          },
          `discourse-collect-${protocol}-p${page}`,
          { maxRetries: 2, baseDelayMs: 3000 },
        )

        const topics = data.topic_list?.topics ?? []
        if (topics.length === 0) {
          hasMore = false
          continue
        }

        const insertBatch = db.transaction(() => {
          for (const topic of topics) {
            const createdAt = new Date(topic.created_at)
            // Skip topics outside our date range
            if (createdAt < from || createdAt > to) continue

            try {
              const result = insertStmt.run(
                topic.id,
                baseUrl,
                topic.title,
                topic.created_at,
                topic.category_id ?? 0,
                topic.posts_count ?? 0,
                topic.reply_count ?? 0,
                topic.views ?? 0,
              )
              if (result.changes > 0) totalInserted++
            } catch {
              // UNIQUE constraint
            }
          }
        })
        insertBatch()

        // Check if we've gone past our date range (topics are in reverse chronological order)
        const lastTopic = topics[topics.length - 1]
        if (lastTopic && new Date(lastTopic.created_at) < from) {
          hasMore = false
        } else {
          page++
        }

      } catch (err) {
        log.error({ protocol, page, err }, 'Failed to fetch forum topics')
        hasMore = false
      }
    }

    log.info({ protocol, topics: totalInserted }, 'Forum collection done')
  }

  log.info({ totalInserted }, 'Forum collection complete')
  return totalInserted
}
