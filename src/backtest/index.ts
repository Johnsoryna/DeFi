/**
 * Backtest CLI entry point.
 *
 * Usage:
 *   # Collect historical data (one-time, stores in SQLite)
 *   npx tsx src/backtest/index.ts collect --from 2025-01-01 --to 2025-12-31
 *
 *   # Run backtest over a date range
 *   npx tsx src/backtest/index.ts run --from 2025-06-01 --to 2025-12-31
 *
 *   # Run with custom initial portfolio
 *   npx tsx src/backtest/index.ts run --from 2025-06-01 --to 2025-12-31 --portfolio 50000
 */
import { parseArgs } from 'node:util'
import path from 'node:path'
import fs from 'node:fs'
import { initBacktestStore } from './schema.js'
import { VirtualClock, setClock } from './clock.js'
import {
  collectGovernanceEvents,
  collectPrices,
  collectSnapshots,
  collectForumPosts,
} from './dataCollector.js'
import { EventReplayProvider } from './replayProvider.js'
import { MockPriceMonitor } from './mockPrice.js'
import { MockExecutor } from './mockExecutor.js'
import { ResultCollector } from './resultCollector.js'
import { generateReport, formatReport, type BacktestReport } from './report.js'
import { wireSignalGenerator } from '../strategy/signalGenerator.js'
import { wireRiskManager, RiskManager } from '../strategy/riskManager.js'
import { setPriceService } from '../strategy/priceService.js'
import { resetTrailingStats } from '../strategy/confidenceScorer.js'
import { parseSpellSource } from '../analysis/spellParser.js'
import {
  analyzeOnchainProposal,
  analyzeSnapshotProposal,
  analyzeForumPost,
} from '../analysis/intelligenceEngine.js'
import { recordSnapshot, recordOnchain, resetCorrelator } from '../analysis/proposalCorrelator.js'
import { getCurrentBlock, setHttpOnlyMode } from '../clients/rpc.js'
import { FORUMS, SNAPSHOT_SPACES } from '../config/addresses.js'
import { createLogger } from '../lib/logger.js'
import { eventBus } from '../lib/eventBus.js'
import type {
  GovernanceEvent,
  ProposalCreatedEvent,
  SnapshotProposalEvent,
  ForumPostEvent,
  GovernanceStage,
  DecodedAction,
  IntelligentAnalysis,
} from '../types/governance.js'

const log = createLogger('backtest')

// ─── CLI Argument Parsing ───────────────────────────────────────────

interface CliArgs {
  command: 'collect' | 'run'
  from: Date
  to: Date
  dbPath: string
  portfolio: number
  fromBlock?: bigint
  toBlock?: bigint
}

function parseCliArgs(): CliArgs {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      from: { type: 'string', short: 'f' },
      to: { type: 'string', short: 't' },
      db: { type: 'string' },
      portfolio: { type: 'string', short: 'p' },
      'from-block': { type: 'string' },
      'to-block': { type: 'string' },
    },
  })

  const command = (positionals[0] ?? 'run') as 'collect' | 'run'
  if (!['collect', 'run'].includes(command)) {
    console.error(`Unknown command: ${command}. Use "collect" or "run".`)
    process.exit(1)
  }

  const now = new Date()
  const sixMonthsAgo = new Date(now)
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)

  const from = values.from ? new Date(values.from) : sixMonthsAgo
  const to = values.to ? new Date(values.to) : now

  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    console.error('Invalid date format. Use ISO format: --from 2025-01-01 --to 2025-12-31')
    process.exit(1)
  }

  // Validate date range
  if (from >= to) {
    console.error(`Invalid date range: 'from' (${from.toISOString()}) must be before 'to' (${to.toISOString()})`)
    process.exit(1)
  }

  return {
    command,
    from,
    to,
    dbPath: values.db ?? './data/backtest.db',
    portfolio: values.portfolio ? parseInt(values.portfolio, 10) : 100_000,
    fromBlock: values['from-block'] ? BigInt(values['from-block']) : undefined,
    toBlock: values['to-block'] ? BigInt(values['to-block']) : undefined,
  }
}

// ─── Collect Command ────────────────────────────────────────────────

async function runCollect(args: CliArgs): Promise<void> {
  // Use HTTP-only transports for data collection (avoids noisy WebSocket ErrorEvents)
  setHttpOnlyMode(true)

  log.info({ from: args.from.toISOString(), to: args.to.toISOString() }, 'Starting data collection')

  const db = initBacktestStore(args.dbPath)

  // Determine block range from the date range.
  // Estimate block numbers: ~7200 blocks/day on Ethereum (12s block time).
  let fromBlock = args.fromBlock
  let toBlock = args.toBlock

  if (!fromBlock || !toBlock) {
    const currentBlock = await getCurrentBlock()

    if (!fromBlock) {
      const daysBackFrom = Math.ceil((Date.now() - args.from.getTime()) / (1000 * 60 * 60 * 24))
      fromBlock = currentBlock - BigInt(daysBackFrom * 7200)
      if (fromBlock < 0n) fromBlock = 0n
    }

    if (!toBlock) {
      // Estimate toBlock based on the --to date, NOT the current block
      const daysBackTo = Math.ceil((Date.now() - args.to.getTime()) / (1000 * 60 * 60 * 24))
      toBlock = currentBlock - BigInt(daysBackTo * 7200)
      // Sanity: toBlock can't exceed the current chain head
      if (toBlock > currentBlock) toBlock = currentBlock
    }
  }

  // Validate block range
  if (fromBlock > toBlock) {
    console.error(`Invalid block range: fromBlock (${fromBlock}) > toBlock (${toBlock})`)
    console.error('This can happen if date range is too recent or block estimation is off.')
    process.exit(1)
  }

  console.log(`\nCollecting data from ${args.from.toISOString()} to ${args.to.toISOString()}`)
  console.log(`Block range: ${fromBlock} → ${toBlock}\n`)

  // 1. Governance events
  console.log('1/4  Collecting governance events...')
  const eventCount = await collectGovernanceEvents(db, fromBlock, toBlock)
  console.log(`     ${eventCount} events cached\n`)

  // 2. Historical prices (all known DeFi tokens, 4h intervals = ~540 calls for 90 days)
  console.log('2/4  Collecting historical prices (1h intervals, all DeFi assets)...')
  const priceCount = await collectPrices(db, args.from, args.to, 3600_000)
  console.log(`     ${priceCount} price points cached\n`)

  // 3. Snapshot proposals
  console.log('3/4  Collecting Snapshot proposals...')
  const snapCount = await collectSnapshots(db, SNAPSHOT_SPACES, args.from, args.to)
  console.log(`     ${snapCount} proposals cached\n`)

  // 4. Forum posts
  console.log('4/4  Collecting forum posts...')
  const forumCount = await collectForumPosts(db, FORUMS, args.from, args.to)
  console.log(`     ${forumCount} forum topics cached\n`)

  console.log('Data collection complete!')
  console.log(`Database: ${path.resolve(args.dbPath)}`)

  db.close()
}

// ─── Analysis Pipeline (mirrors production src/index.ts) ─────────────

/**
 * Wire the analysis pipeline using the Intelligence Engine.
 * Replaces the old pattern-matching classifier with NLP-powered analysis.
 */
function wireAnalysisPipeline(clock: VirtualClock, riskManager: RiskManager): void {
  // Track proposal stages for risk manager transitions
  const proposalStages = new Map<string, GovernanceStage>()

  // Cache proposal analyses for re-entry on stage transitions.
  // When a proposal passes voting (queued/executed), we can RE-EMIT the analysis
  // with the new stage → signal generator creates a "second chance" signal if
  // the original position was already closed (SL/TP hit).
  const cachedAnalyses = new Map<string, IntelligentAnalysis>()

  // Reset correlator state for clean backtest run
  resetCorrelator()

  // ── governance:proposal → Intelligence Engine → analysis:proposal ──
  // On-chain trading disabled by default.
  // Ethereum alpha is primarily captured via forum/snapshot signals.
  // Non-Ethereum on-chain (cosmos/injective/arbitrum) can be re-enabled later if needed.
  // Ethereum DeFi protocols (aave, compound, uniswap, lido, ethena, curve, dydx)
  // are NOT included here — their forum/snapshot signals capture alpha earlier.
  const ONCHAIN_TRADE_ENABLED = new Set<string>([])
  
  eventBus.on('governance:proposal', (event: GovernanceEvent) => {
    if (event.type !== 'proposal_created') return
    const proposal = event as ProposalCreatedEvent
    
    const isOnchainTradeEnabled = ONCHAIN_TRADE_ENABLED.has(proposal.protocol)
    
    try {
      let spellActions: DecodedAction[] | undefined
      if (proposal.protocol === 'maker' && proposal.description) {
        const parsed = parseSpellSource(proposal.description, proposal.targets[0] ?? '')
        if (parsed.length > 0) spellActions = parsed
      }
      const analysis = analyzeOnchainProposal(proposal, spellActions)
      cachedAnalyses.set(analysis.proposalId, analysis)
      recordOnchain(proposal, analysis)
      
      // Trade Cosmos SDK + Tally L2 chains, record-only for Ethereum chains
      if (isOnchainTradeEnabled) {
        log.debug({ proposalId: proposal.proposalId.toString(), protocol: proposal.protocol }, 'On-chain proposal — trading enabled')
        if (analysis.impacts.length > 0 || analysis.dynamicImpacts.length > 0) {
          eventBus.emit('analysis:proposal', analysis)
        }
      } else {
        log.debug({ proposalId: proposal.proposalId.toString() }, 'On-chain recorded (Ethereum — trading disabled)')
      }
    } catch (err) {
      log.debug({ err }, 'On-chain analysis skipped')
    }
  })

  // ── Stage transitions ──
  const handleStageTransition = (event: GovernanceEvent) => {
    let proposalId: string | undefined
    let newStage: GovernanceStage | undefined

    switch (event.type) {
      case 'proposal_queued':
        proposalId = `${event.protocol}:${event.proposalId}`
        newStage = 'timelock'
        break
      case 'proposal_executed':
        proposalId = `${event.protocol}:${event.proposalId}`
        newStage = 'executed'
        break
      case 'proposal_canceled':
        proposalId = `${event.protocol}:${event.proposalId}`
        newStage = 'canceled'
        break
    }

    if (!proposalId || !newStage) return
    proposalStages.set(proposalId, newStage)

    const reductions = riskManager.handleStageTransition(proposalId, newStage)
    for (const reduction of reductions) {
      log.info(
        { positionId: reduction.positionId, reduceByPct: reduction.reduceByPct, stage: newStage },
        'Stage transition — reducing position',
      )
    }

    // ─── STAGE-TRANSITION RE-ENTRY (Shorts Only) ─────────────────
    // When a proposal is queued (passed voting), re-emit for potential short re-entry.
    // Use case: original short was stopped out by volatility, but the proposal IS
    // going to execute → our bearish thesis is confirmed. Re-enter at timelock stage
    // with higher confidence (0.85 vs 0.6 for onchain_vote).
    // ONLY for shorts: longs at timelock stage are too late (market already priced in).
    if (newStage === 'timelock' && cachedAnalyses.has(proposalId)) {
      const originalAnalysis = cachedAnalyses.get(proposalId)!
      // Only re-emit if the original had bearish impacts (risk_mitigation, technical decrease)
      const hasBearishImpact = originalAnalysis.dynamicImpacts?.some(
        i => i.type === 'risk_mitigation' ||
             (i.type === 'technical_parameter' && i.expectedPriceImpact === 'negative') ||
             (i.type === 'economic_policy' && i.expectedPriceImpact === 'negative')
      )
      if (hasBearishImpact) {
        const reentryAnalysis: IntelligentAnalysis = {
          ...originalAnalysis,
          stage: newStage,
          // Keep original proposalId (no -reentry suffix) — matches live index.ts behaviour.
          confidenceScore: 0.85,
          timestamp: clock.now(),
        }
        log.info(
          { proposalId, assets: reentryAnalysis.extractedAssets },
          'Timelock re-entry — bearish proposal confirmed, re-emitting for potential short',
        )
        eventBus.emit('analysis:proposal', reentryAnalysis)
      }
    }
    // ─── end stage-transition re-entry ──────────────────────────
  }

  eventBus.on('governance:queued', handleStageTransition)
  eventBus.on('governance:executed', handleStageTransition)
  eventBus.on('governance:canceled', handleStageTransition)

  // ── Snapshot proposals → Intelligence Engine (NLP-powered) ──
  // 1INCH: no Binance perps for 1INCH, skip before NLP to avoid wasted CPU.
  // synthetix: snxgov.eth proposals are routine governance — 50% WR, -$2,212 backtest result.
  //   No forum source either; Snapshot signals are noise, not alpha.
  // Note: 'curve' removed from this set (Feb 2026) — no space maps to 'curve' anymore
  //       after remapping (cvx.eth→convex, veyfi.eth→yearn).
  const NON_ALPHA_SNAPSHOT_PROTOCOLS = new Set(['1inch', 'synthetix'])

  eventBus.on('governance:snapshot', (event: GovernanceEvent) => {
    const snap = event as SnapshotProposalEvent
    if (NON_ALPHA_SNAPSHOT_PROTOCOLS.has(snap.protocol)) return

    log.debug({ title: snap.title, space: snap.space, state: snap.state }, 'Snapshot proposal replayed')

    try {
      // Use Intelligence Engine NLP analysis
      const analysis = analyzeSnapshotProposal(snap)

      // Record for correlation even if not actionable
      recordSnapshot(snap, analysis ?? undefined)

      if (!analysis) return // Not actionable — skip

      // Cache Snapshot analysis for potential on-chain stage-transition re-entry
      const snapCacheKey = `snapshot:${snap.protocol}:${snap.snapshotId?.slice(0, 12) ?? 'unknown'}`
      cachedAnalyses.set(snapCacheKey, analysis)

      eventBus.emit('analysis:proposal', analysis)
    } catch (err) {
      log.debug({ err, title: snap.title }, 'Snapshot analysis skipped')
    }
  })

  // ── Forum posts → Intelligence Engine (sentiment signal) ──
  eventBus.on('governance:forum', (event: GovernanceEvent) => {
    const forum = event as ForumPostEvent
    log.debug({ title: forum.title, forumUrl: forum.forumUrl }, 'Forum post replayed')

    try {
      const analysis = analyzeForumPost(forum)
      if (analysis) {
        eventBus.emit('analysis:proposal', analysis)
      }
    } catch (err) {
      log.debug({ err, title: forum.title }, 'Forum analysis skipped')
    }
  })

  log.info('Intelligence Engine pipeline wired')
}

// ─── Run Command ────────────────────────────────────────────────────

async function runBacktest(args: CliArgs): Promise<BacktestReport> {
  log.info(
    { from: args.from.toISOString(), to: args.to.toISOString(), portfolio: args.portfolio },
    'Starting backtest',
  )

  const db = initBacktestStore(args.dbPath)

  // Check that we have data
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const eventCount = (db.prepare('SELECT COUNT(*) as c FROM historical_events').get() as any).c
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const priceCount = (db.prepare('SELECT COUNT(*) as c FROM historical_prices').get() as any).c
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const snapCount = (db.prepare('SELECT COUNT(*) as c FROM historical_snapshots').get() as any).c
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const forumCount = (db.prepare('SELECT COUNT(*) as c FROM historical_forum_posts').get() as any).c

  if (eventCount === 0) {
    console.error('No historical events found. Run "collect" first:')
    console.error(`  npx tsx src/backtest/index.ts collect --from ${args.from.toISOString().slice(0, 10)} --to ${args.to.toISOString().slice(0, 10)}`)
    process.exit(1)
  }

  console.log(`\nBacktest: ${args.from.toISOString().slice(0, 10)} → ${args.to.toISOString().slice(0, 10)}`)
  console.log(`Data: ${eventCount} events, ${priceCount} prices, ${snapCount} snapshots, ${forumCount} forum posts`)
  console.log(`Portfolio: $${args.portfolio.toLocaleString()}\n`)

  // 1. Initialize virtual clock
  const clock = new VirtualClock(args.from.getTime())
  const prevClock = setClock(clock)

  // 2. Initialize mock services
  const mockPrices = new MockPriceMonitor(db, clock)

  // Inject price service for signal generator regime filter + ATR access
  setPriceService(mockPrices)

  // Reset adaptive Kelly tracker for clean backtest
  resetTrailingStats()

  // 3. Initialize result collector (before executor, so we can pass portfolio accessor)
  const collector = new ResultCollector(clock, mockPrices, args.portfolio)

  // MockExecutor needs access to current portfolio value for proper position sizing
  const mockExecutor = new MockExecutor(
    mockPrices, clock, undefined, undefined,
    () => collector.getPortfolioValue(),
  )
  collector.start()

  // 4. Wire analysis pipeline (IDENTICAL to production src/index.ts)
  const riskManager = new RiskManager()
  // Initialize risk manager with starting portfolio value
  riskManager.updatePortfolio([], collector.getPortfolioValue())
  wireAnalysisPipeline(clock, riskManager)

  // 5. Wire signal generator with access to current positions
  wireSignalGenerator(() => collector.getCurrentPositions())

  // 6. Wire risk manager (signals → validated signals) — same as production line 336
  wireRiskManager(riskManager)

  // 7. Wire position updates to risk manager
  eventBus.on('position:update', (update) => {
    riskManager.updatePortfolio(update.positions, collector.getPortfolioValue())
  })

  // 8. Wire mock executor (replaces wireTradeExecutor from production line 339)
  mockExecutor.wire()

  // 8. Replay events (with periodic exit checks every 6 simulated hours)
  console.log('Replaying events...')
  const replay = new EventReplayProvider(db, clock)
  const { eventsReplayed } = await replay.replay(args.from, args.to, () => {
    collector.checkExits()
  })
  console.log(`Replayed ${eventsReplayed} events\n`)

  // 9. Close open positions at end of backtest
  collector.closeAllPositions()

  // 10. Generate report
  const report = generateReport(collector, {
    from: args.from,
    to: args.to,
    eventsReplayed,
    initialPortfolio: args.portfolio,
  })

  // 11. Print report
  console.log(formatReport(report))

  // 12. Save report to JSON
  const reportPath = args.dbPath.replace('.db', '-report.json')
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(`Report saved to: ${path.resolve(reportPath)}`)

  // 13. Save trades detail for analysis
  const tradesPath = args.dbPath.replace('.db', '-trades.json')
  fs.writeFileSync(tradesPath, JSON.stringify(collector.trades, null, 2))
  console.log(`Trades saved to: ${path.resolve(tradesPath)}`)

  // Cleanup
  setClock(prevClock)
  setPriceService(null)
  eventBus.removeAllListeners()
  db.close()

  return report
}

// ─── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseCliArgs()

  try {
    if (args.command === 'collect') {
      await runCollect(args)
    } else {
      await runBacktest(args)
    }
  } catch (err) {
    log.error({ err }, 'Backtest error')
    console.error('Error:', err)
    process.exit(1)
  }
}

main()
