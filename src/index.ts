/**
 * DeFi Governance Alpha Bot — Main Entry Point
 *
 * Orchestrates all layers:
 *   Monitoring → Analysis → Signal Generation → Risk Management → Execution → Alerts
 *
 * The analysis pipeline (governance events → analysis → signals) is an EXACT 1:1
 * copy of the backtest's wireAnalysisPipeline in src/backtest/index.ts.
 * Only infrastructure differs (real monitors/executor vs mock replay/executor).
 */

// ─── WebSocket Polyfill for Node.js (required by Binance WebSocket) ──
import WebSocket from 'ws'
if (typeof globalThis.WebSocket === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as Record<string, any>).WebSocket = WebSocket
}

import { config, validateConfigForLiveTrading } from './config/index.js'
import { initStore, closeStore } from './lib/store.js'
import { createLogger } from './lib/logger.js'
import { eventBus } from './lib/eventBus.js'
import { sleep } from './lib/retry.js'

// Layer 1 — Monitors
import { startAllMonitors, stopAllMonitors } from './monitor/index.js'

// Layer 2 — Analysis (same functions as backtest)
import {
  analyzeOnchainProposal,
  analyzeSnapshotProposal,
  analyzeForumPost,
} from './analysis/intelligenceEngine.js'
import { recordSnapshot, recordOnchain, resetCorrelator } from './analysis/proposalCorrelator.js'
import { parseSpellSource } from './analysis/spellParser.js'

// Layer 2 — Processing
import { startPositionTracker, stopPositionTracker, setWalletAddress } from './processing/positionTracker.js'
import { startPriceMonitor, stopPriceMonitor } from './processing/priceMonitor.js'

// Layer 3 — Strategy (same wiring as backtest)
import { wireSignalGenerator } from './strategy/signalGenerator.js'
import { RiskManager, wireRiskManager, recordStopLoss, recordWin, recordGlobalLoss, recordMonthlyPnl } from './strategy/riskManager.js'
import { setPriceService } from './strategy/priceService.js'
import { resetTrailingStats, recordTradeOutcome } from './strategy/confidenceScorer.js'
import { getLivePriceService, startLivePriceHistory } from './processing/livePriceService.js'

// Layer 4 — Execution
import { wireTradeExecutor } from './execution/tradeExecutor.js'
import { cancelPositionOrders, reducePosition } from './execution/binanceExecutor.js'
import { startAlertService, sendAlert } from './execution/alertService.js'

import type { ProposalCreatedEvent, GovernanceEvent, SnapshotProposalEvent, DecodedAction, ForumPostEvent, GovernanceStage, IntelligentAnalysis } from './types/governance.js'
import type { ExecutionResult, Position } from './types/trading.js'

const log = createLogger('main')

// ─── Global State ───────────────────────────────────────────────────

let running = false
let riskManager: RiskManager
let currentPositions: Position[] = []

// Previous positions snapshot for detecting position closures (win/loss tracking)
let previousPositions: Position[] = []

// Max-holding-time tracking: Binance symbol → { entryTime, maxHoldingHours }
// Populated on execution:result; cleaned up on position close or expiry.
const positionHoldingMeta = new Map<string, { entryTime: number; maxHoldingHours: number }>()

// Cached live portfolio equity (mirrors backtest's collector.getPortfolioValue())
let cachedLiveEquity = 0
let liveEquityCacheTs = 0

async function getLivePortfolioValue(): Promise<number> {
  if (!config.binanceApiKey || !config.binanceApiSecret) return config.initialPortfolioUsd
  if (Date.now() - liveEquityCacheTs < 30_000 && cachedLiveEquity > 0) return cachedLiveEquity
  const { getAccountInfo } = await import('./clients/binance.js')
  const account = await getAccountInfo()
  const equity = parseFloat(account.totalMarginBalance)
  if (equity > 0) {
    cachedLiveEquity = equity
    liveEquityCacheTs = Date.now()
    return equity
  }
  return cachedLiveEquity > 0 ? cachedLiveEquity : config.initialPortfolioUsd
}

// ─── Analysis Pipeline (1:1 copy of backtest wireAnalysisPipeline) ──
// This function wires the exact same event handlers as the backtest.
// NO extras: no cascade impacts, no liquidation sim, no DB persistence,
// no alerts inside handlers, no spell fetching from chain.

function wireAnalysisPipeline(rm: RiskManager): void {
  // Track proposal stages for risk manager transitions
  const proposalStages = new Map<string, GovernanceStage>()

  // Cache proposal analyses for re-entry on stage transitions.
  // (Matches backtest: only snapshot analyses are cached — on-chain are NOT cached)
  const cachedAnalyses = new Map<string, IntelligentAnalysis>()

  // Reset correlator state (matches backtest)
  resetCorrelator()

  // ── governance:proposal → Intelligence Engine → analysis:proposal ──
  // IDENTICAL to backtest wireAnalysisPipeline lines 213-245
  const ONCHAIN_TRADE_ENABLED = new Set([
    'cosmos', 'injective', 'arbitrum',
  ])

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
      const _stageKey = `${proposal.protocol}:${proposal.proposalId}`
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
  // IDENTICAL to backtest wireAnalysisPipeline lines 248-312
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

    const reductions = rm.handleStageTransition(proposalId, newStage)
    for (const reduction of reductions) {
      log.info(
        { positionId: reduction.positionId, reduceByPct: reduction.reduceByPct, stage: newStage },
        'Stage transition — reducing position',
      )
    }

    // ─── STAGE-TRANSITION RE-ENTRY (Shorts Only) ─────────────────
    if (newStage === 'timelock' && cachedAnalyses.has(proposalId)) {
      const originalAnalysis = cachedAnalyses.get(proposalId)!
      const hasBearishImpact = originalAnalysis.dynamicImpacts?.some(
        i => i.type === 'risk_mitigation' ||
             (i.type === 'technical_parameter' && i.expectedPriceImpact === 'negative') ||
             (i.type === 'economic_policy' && i.expectedPriceImpact === 'negative')
      )
      if (hasBearishImpact) {
        const reentryAnalysis: IntelligentAnalysis = {
          ...originalAnalysis,
          stage: newStage,
          proposalId: `${originalAnalysis.proposalId}-reentry`,
          confidenceScore: 0.85,
          timestamp: Date.now(),
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
  // IDENTICAL to backtest wireAnalysisPipeline — keep in sync
  // Protocols with no tradeable assets (CRV/SNX removed, 1INCH never in list) —
  // skip before NLP to avoid wasting CPU on signals that will always be discarded.
  const NON_ALPHA_SNAPSHOT_PROTOCOLS = new Set(['curve', 'synthetix', '1inch'])

  eventBus.on('governance:snapshot', (event: GovernanceEvent) => {
    const snap = event as SnapshotProposalEvent
    if (NON_ALPHA_SNAPSHOT_PROTOCOLS.has(snap.protocol)) return

    log.debug({ title: snap.title, space: snap.space, state: snap.state }, 'Snapshot proposal detected')

    try {
      const analysis = analyzeSnapshotProposal(snap)
      recordSnapshot(snap, analysis ?? undefined)
      if (!analysis) return

      const snapCacheKey = `snapshot:${snap.protocol}:${snap.snapshotId?.slice(0, 12) ?? 'unknown'}`
      cachedAnalyses.set(snapCacheKey, analysis)

      eventBus.emit('analysis:proposal', analysis)
    } catch (err) {
      log.debug({ err, title: snap.title }, 'Snapshot analysis skipped')
    }
  })

  // ── Forum posts → Intelligence Engine (sentiment signal) ──
  // IDENTICAL to backtest wireAnalysisPipeline lines 339-351
  eventBus.on('governance:forum', (event: GovernanceEvent) => {
    const forum = event as ForumPostEvent
    log.debug({ title: forum.title, forumUrl: forum.forumUrl }, 'Forum post detected')

    try {
      const analysis = analyzeForumPost(forum)
      if (analysis) {
        eventBus.emit('analysis:proposal', analysis)
      }
    } catch (err) {
      log.debug({ err, title: forum.title }, 'Forum analysis skipped')
    }
  })

  log.info('Intelligence Engine pipeline wired (1:1 backtest parity)')
}

// ─── Main Boot Sequence ─────────────────────────────────────────────

async function main(): Promise<void> {
  log.info('╔══════════════════════════════════════════════╗')
  log.info('║   DeFi Governance Alpha Bot — Starting...    ║')
  log.info('╚══════════════════════════════════════════════╝')
  log.info({ dryRun: config.dryRun }, config.dryRun
    ? 'Mode: DRY RUN (orders will NOT be sent)'
    : 'Mode: LIVE TRADING (real orders will be placed!)')

  // 0. Validate config for current mode
  const configWarnings = validateConfigForLiveTrading()
  for (const w of configWarnings) {
    log.warn(w)
  }

  // 1. Initialize database
  initStore()
  log.info('Database initialized')

  // 2. Initialize risk manager + reset adaptive Kelly tracker
  // (matches backtest: resetTrailingStats() + new RiskManager() + updatePortfolio([], portfolio))
  resetTrailingStats()
  riskManager = new RiskManager()
  riskManager.updatePortfolio([], config.initialPortfolioUsd)

  // 3. Set wallet addresses if configured
  if (config.ethPrivateKey) {
    try {
      const { getWalletAddress } = await import('./clients/rpc.js')
      const address = getWalletAddress()
      setWalletAddress(address)
      log.info({ address }, 'ETH wallet configured')
    } catch {
      log.warn('No ETH wallet configured — on-chain trades will fail')
    }
  }

  if (config.binanceApiKey && config.binanceApiSecret) {
    const binance = await import('./clients/binance.js')
    await binance.ensureOneWayMode()
    log.info('Binance API configured — order execution available')
  }

  // 4. Wire analysis pipeline (IDENTICAL to backtest wireAnalysisPipeline)
  wireAnalysisPipeline(riskManager)

  // 5. Wire signal generator (analysis → signals)
  // (matches backtest step 5: wireSignalGenerator(() => collector.getCurrentPositions()))
  wireSignalGenerator(() => currentPositions)

  // 6. Wire risk manager (signals → validated signals)
  // (matches backtest step 6: wireRiskManager(riskManager))
  wireRiskManager(riskManager)

  // 7. Wire position updates to risk manager + position close detection
  // (matches backtest step 7: eventBus.on('position:update', ...) → riskManager.updatePortfolio
  //  + live equivalent of ResultCollector.closeTrade for win/loss tracking)
  eventBus.on('position:update', (update) => {
    const newPositions = update.positions

    // ─── Position Close Detection ──────────────────────────────────
    // Detect positions that disappeared (closed on exchange via SL/TP/manual)
    // and record win/loss — mirrors backtest ResultCollector.closeTrade()
    const currentIds = new Set(newPositions.map((p: Position) => p.id))
    for (const prev of previousPositions) {
      if (!currentIds.has(prev.id)) {
        const realizedPnl = parseFloat(prev.realizedPnl || '0')
        const unrealizedPnl = parseFloat(prev.unrealizedPnl || '0')
        const pnl = realizedPnl !== 0 ? realizedPnl : unrealizedPnl
        const now = Date.now()

        // Record for adaptive Kelly (matches backtest: recordTradeOutcome first)
        const margin = Math.abs(parseFloat(prev.size || '0')) * parseFloat(prev.entryPrice || '0')
        if (margin > 0) {
          recordTradeOutcome(pnl, margin)
        }

        // Record win/loss for consecutive loss cooldown
        if (pnl < 0) {
          recordStopLoss(prev.asset, now)
          recordGlobalLoss(now)
        } else if (pnl > 0) {
          recordWin(prev.asset)
        }

        // Record P&L for monthly loss budget
        recordMonthlyPnl(now, pnl)

        log.info(
          { id: prev.id, asset: prev.asset, pnl: pnl.toFixed(2), protocol: prev.protocol },
          'Position closure detected and recorded',
        )

        // Cancel any remaining protective orders (SL / trailing-stop / TP)
        // on the closed symbol so they don't interfere with future positions.
        if (prev.protocol === 'binance') {
          const symbol = prev.id.replace('binance:', '')
          positionHoldingMeta.delete(symbol)
          cancelPositionOrders(symbol).catch((err) =>
            log.warn({ err, symbol }, 'Order cleanup after position close failed'),
          )
        }
      }
    }
    previousPositions = [...newPositions]
    // ─── End Position Close Detection ──────────────────────────────

    currentPositions = newPositions

    // Update risk manager with real Binance equity (matches backtest: dynamic portfolioValue)
    getLivePortfolioValue().then((portfolioValue) => {
      riskManager.updatePortfolio(currentPositions, portfolioValue)
    }).catch(() => {
      riskManager.updatePortfolio(currentPositions, config.initialPortfolioUsd)
    })
  })

  // 8. Wire trade executor (validated signals → execution)
  // (live equivalent of backtest step 8: mockExecutor.wire())
  wireTradeExecutor()

  // 8a. Track execution results for max-holding-time monitoring.
  // When a trade executes (dry-run or live), record the entry time and maxHoldingHours
  // keyed by Binance symbol so the holding-time loop can close expired positions.
  eventBus.on('execution:result', (result: ExecutionResult) => {
    if (!result.success) return
    const symbol = result.metadata?.symbol as string | undefined
    const maxHoldingHours = result.metadata?.maxHoldingHours as number | undefined
    if (!symbol || !maxHoldingHours) return
    positionHoldingMeta.set(symbol, { entryTime: Date.now(), maxHoldingHours })
    log.debug({ symbol, maxHoldingHours }, 'Position entry recorded — max-holding-time tracking active')
  })

  // 8b. Max-holding-time monitor loop — mirrors backtest's resultCollector.closeTrade()
  // 'max-holding-time' exit. Checks every 30 min; closes positions held beyond maxHoldingHours.
  maxHoldingTimeMonitor().catch((err) => {
    log.error({ err }, 'Max-holding-time monitor crashed')
  })

  // 9. Start alert service (operational — not in backtest but doesn't affect trading logic)
  startAlertService()

  // 10. Start all monitors (live equivalent of backtest's EventReplayProvider)
  await startAllMonitors()

  // 11. Start price monitor + wire live price service
  // (live equivalent of backtest's MockPriceMonitor + setPriceService(mockPrices))
  startPriceMonitor()
  startLivePriceHistory()
  setPriceService(getLivePriceService())
  log.info('Live PriceService wired — A3/B2 filters active')

  // 12. Start position tracker (live equivalent of backtest's ResultCollector)
  startPositionTracker()

  // 13. Keep alive
  running = true
  keepAliveLoop().catch((err) => {
    log.fatal({ err }, 'Keep-alive loop crashed')
    shutdown('keepalive_crash').catch(() => process.exit(1))
  })

  // 14. Startup notification
  await sendAlert(
    'system_health',
    'info',
    'Bot Started',
    [
      'DeFi Governance Alpha Bot is now running.',
      `Log level: ${config.logLevel}`,
      `Polling interval: ${config.pollingIntervalMs}ms`,
    ].join('\n'),
  )

  log.info('All systems operational')
}

// ─── Max-Holding-Time Monitor ───────────────────────────────────────
// Mirrors backtest resultCollector behaviour: closes positions after maxHoldingHours.
// Checks every 30 minutes. When a position exceeds its max holding time, a 100%
// reduce market order is placed — identical to the backtest 'max-holding-time' exit.

async function maxHoldingTimeMonitor(): Promise<void> {
  while (running) {
    await sleep(30 * 60_000) // Check every 30 min

    const now = Date.now()
    for (const [symbol, meta] of positionHoldingMeta) {
      const holdingHours = (now - meta.entryTime) / 3_600_000

      if (holdingHours < meta.maxHoldingHours) continue

      // Find position in current snapshot
      const pos = currentPositions.find((p) => p.id === `binance:${symbol}`)
      if (!pos || parseFloat(pos.size) === 0) {
        positionHoldingMeta.delete(symbol)
        continue
      }

      log.info(
        { symbol, holdingHours: holdingHours.toFixed(1), maxHoldingHours: meta.maxHoldingHours },
        'Max-holding-time exceeded — closing position (mirrors backtest exit)',
      )

      try {
        await sendAlert(
          'trade_exit', 'info',
          `Max-Holding-Time Exit: ${symbol}`,
          `Held ${holdingHours.toFixed(0)}h / max ${meta.maxHoldingHours}h — closing at market.`,
        )
        await reducePosition(symbol, pos.size, 100)
        positionHoldingMeta.delete(symbol)
        log.info({ symbol }, 'Max-holding-time close executed')
      } catch (err) {
        log.error({ err, symbol }, 'Max-holding-time close failed — will retry in 30 min')
      }
    }
  }
}

// ─── Keep-Alive Loop ────────────────────────────────────────────────

async function keepAliveLoop(): Promise<void> {
  while (running) {
    await sleep(60_000)
    log.debug({ positions: currentPositions.length }, 'Keep-alive tick')
  }
}

// ─── Graceful Shutdown ──────────────────────────────────────────────

async function shutdown(reason: string): Promise<void> {
  log.info({ reason }, 'Shutting down...')
  running = false

  eventBus.emit('system:shutdown', { reason })

  // Stop in reverse order
  stopPositionTracker()
  stopPriceMonitor()
  stopAllMonitors()

  // Send final alert
  try {
    await sendAlert('system_health', 'warning', 'Bot Stopped', `Reason: ${reason}`)
  } catch {
    // Best effort
  }

  // Close database
  closeStore()

  log.info('Shutdown complete')
  process.exit(0)
}

// ─── Signal Handlers ────────────────────────────────────────────────

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((err) => {
    log.fatal({ err }, 'Shutdown failed on SIGINT')
    process.exit(1)
  })
})

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((err) => {
    log.fatal({ err }, 'Shutdown failed on SIGTERM')
    process.exit(1)
  })
})

process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'Uncaught exception')
  // Give shutdown 5 seconds to complete
  const timeout = setTimeout(() => {
    log.fatal('Shutdown timeout — forcing exit')
    process.exit(1)
  }, 5000)
  
  shutdown('uncaughtException')
    .catch(() => {})
    .finally(() => {
      clearTimeout(timeout)
      process.exit(1)
    })
})

process.on('unhandledRejection', (reason) => {
  log.error({ reason }, 'Unhandled rejection')
  // Don't exit on unhandled rejection, just log it
})

// ─── Start ──────────────────────────────────────────────────────────

main().catch((err) => {
  log.fatal({ err }, 'Fatal startup error')
  process.exit(1)
})
