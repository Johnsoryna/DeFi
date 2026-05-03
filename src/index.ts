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
import { initStore, closeStore, upsertProposal, getActiveProposals, getProposal } from './lib/store.js'
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
import { refreshGraph } from './analysis/dependencyGraph.js'

// Layer 2 — Processing
import { startPositionTracker, stopPositionTracker, setWalletAddress } from './processing/positionTracker.js'
import { startPriceMonitor, stopPriceMonitor } from './processing/priceMonitor.js'

// Layer 3 — Strategy (same wiring as backtest)
import { wireSignalGenerator } from './strategy/signalGenerator.js'
import { RiskManager, wireRiskManager, recordStopLoss, recordWin, recordGlobalLoss, recordMonthlyPnl, resetGlobalLosses } from './strategy/riskManager.js'
import { setPriceService } from './strategy/priceService.js'
import { resetTrailingStats, recordTradeOutcome } from './strategy/confidenceScorer.js'
import { getLivePriceService, startLivePriceHistory } from './processing/livePriceService.js'

// Layer 4 — Execution
import { wireTradeExecutor } from './execution/tradeExecutor.js'
import { cancelPositionOrders, reduceAndRearm, clearProtectionState } from './execution/binanceExecutor.js'
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

// Position open-time tracking: Binance symbol → epoch ms when first seen open.
// Used to query income history at close time (realizedPnl on open-position snapshots is always 0).
const positionOpenTimeMs = new Map<string, number>()

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
  // Cache proposal analyses for re-entry on stage transitions.
  const cachedAnalyses = new Map<string, IntelligentAnalysis>()

  // Restore cached analyses from DB (survive restarts — enables timelock re-entry)
  for (const row of getActiveProposals()) {
    if (row.analysis) {
      try {
        const analysis = JSON.parse(row.analysis as string) as IntelligentAnalysis
        cachedAnalyses.set(row.id as string, analysis)
      } catch { /* ignore corrupt rows */ }
    }
  }
  if (cachedAnalyses.size > 0) {
    log.info({ restored: cachedAnalyses.size }, 'Cached analyses restored from DB')
  }

  // Reset correlator state (matches backtest)
  resetCorrelator()

  // ── governance:proposal → Intelligence Engine → analysis:proposal ──
  // IDENTICAL to backtest wireAnalysisPipeline lines 213-245
  // Runtime-configurable on-chain trading allowlist.
  // Default is empty; proposal events are still ingested/analyzed for record/correlation.
  const ONCHAIN_TRADE_ENABLED = new Set(config.onchainTradeEnabledProtocols)

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
      // Cache on-chain analysis for stage-transition re-entry and reduction
      // Key matches stage-transition handler: "${protocol}:${proposalId}"
      // (analysis.proposalId now uses this format after intelligenceEngine fix)
      cachedAnalyses.set(analysis.proposalId, analysis)
      upsertProposal({
        id: analysis.proposalId,
        protocol: analysis.protocol,
        stage: analysis.stage,
        title: analysis.title ?? proposal.description?.slice(0, 200) ?? '',
        analysis: JSON.stringify(analysis, (_, v) => typeof v === 'bigint' ? v.toString() : v),
      })
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

    // Update proposal stage in DB so getActiveProposals() excludes executed/canceled on next restart
    const existingProposal = getProposal(proposalId)
    if (existingProposal) {
      upsertProposal({ id: proposalId, protocol: existingProposal.protocol as string, stage: newStage })
    }

    const reductions = rm.handleStageTransition(proposalId, newStage)
    for (const reduction of reductions) {
      log.info(
        { positionId: reduction.positionId, reduceByPct: reduction.reduceByPct, stage: newStage },
        'Stage transition — executing position reduction',
      )
      // positionId format: "binance:SYMBOL" — derive symbol and execute reduce
      const symbol = reduction.positionId.replace('binance:', '')
      const pos = currentPositions.find(p => p.id === reduction.positionId)
      if (pos && parseFloat(pos.size) !== 0) {
        // reduceAndRearm: reduce position, cancel stale orders, re-arm protection for remaining size
        reduceAndRearm(symbol, pos.size, reduction.reduceByPct).catch((err) =>
          log.error({ err, symbol, reduceByPct: reduction.reduceByPct }, 'Stage-based position reduction failed'),
        )
      } else if (!pos && config.binanceApiKey && config.binanceApiSecret) {
        // Race condition: stage event arrived before positionTracker updated currentPositions.
        // Query Binance directly so the reduction is not silently skipped.
        import('./clients/binance.js')
          .then((b) => b.getPositions())
          .then((livePositions) => {
            const livePos = livePositions.find((p) => p.symbol === symbol)
            if (livePos && parseFloat(livePos.positionAmt) !== 0) {
              void reduceAndRearm(symbol, livePos.positionAmt, reduction.reduceByPct).catch((err) =>
                log.error({ err, symbol, reduceByPct: reduction.reduceByPct }, 'Stage-based live reduction failed'),
              )
              return
            }
            log.debug({ symbol, proposalId }, 'Stage reduction: position already closed on exchange')
          })
          .catch((err) => log.warn({ err, symbol }, 'Stage reduction: live position lookup failed'))
      }
    }

    // ─── STAGE-TRANSITION RE-ENTRY (Shorts Only) ─────────────────
    // Fires when a bearish on-chain proposal reaches timelock — adds conviction short.
    // proposalId format is consistent: "${protocol}:${proposalId}" in both directions.
    // Guard: only re-enter if the protocol has on-chain trading enabled.
    // cachedAnalyses is populated for ALL on-chain protocols (including record-only Ethereum chains),
    // so we must explicitly check ONCHAIN_TRADE_ENABLED to avoid bypassing the trading disable.
    const reentryProtocol = proposalId.split(':')[0]
    if (newStage === 'timelock' && ONCHAIN_TRADE_ENABLED.has(reentryProtocol) && cachedAnalyses.has(proposalId)) {
      const originalAnalysis = cachedAnalyses.get(proposalId)!
      // Guard: don't re-enter if already in a position on this symbol.
      // Normalize wrapped-token aliases (WETH→ETH, WBTC→BTC) — extractedAssets from NLP
      // may return the wrapped form while Binance positions store the unwrapped ticker.
      const normalizeAsset = (a: string) => a.replace(/^W(ETH|BTC)$/, '$1').replace(/^CBBTC$/, 'BTC')
      const alreadyOpen = originalAnalysis.extractedAssets?.some(
        asset => currentPositions.some(p => normalizeAsset(p.asset) === normalizeAsset(asset))
      )
      const hasBearishImpact = originalAnalysis.dynamicImpacts?.some(
        i => i.type === 'risk_mitigation' ||
             (i.type === 'technical_parameter' && i.expectedPriceImpact === 'negative') ||
             (i.type === 'economic_policy' && i.expectedPriceImpact === 'negative')
      )
      if (hasBearishImpact && !alreadyOpen) {
        const reentryAnalysis: IntelligentAnalysis = {
          ...originalAnalysis,
          stage: newStage,
          // Keep original proposalId (no -reentry suffix) so executed/canceled events can still find it
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

  // Evict cachedAnalyses when proposals reach terminal states (executed or canceled).
  // Proposals in these states will never generate new signals, so the cache entry is stale.
  // Without eviction the map grows unbounded over months of operation.
  function evictProposalCache(event: GovernanceEvent): void {
    if (event.type !== 'proposal_executed' && event.type !== 'proposal_canceled') return
    // Key format matches handleStageTransition: "${protocol}:${proposalId}"
    const key = `${event.protocol}:${event.proposalId}`
    if (cachedAnalyses.delete(key)) {
      log.debug({ key }, 'Evicted proposal from analysis cache (terminal state)')
    }
  }
  eventBus.on('governance:executed', evictProposalCache)
  eventBus.on('governance:canceled', evictProposalCache)

  // ── Snapshot proposals → Intelligence Engine (NLP-powered) ──
  // IDENTICAL to backtest wireAnalysisPipeline — keep in sync
  // 1inch: no Binance perps for 1INCH → always discarded.
  // synthetix: snxgov.eth proposals are routine governance (50% WR, -$2,212 backtest).
  // Note: 'curve' is NOT in this set — no Snapshot space maps to 'curve' (cvx.eth→convex,
  // veyfi.eth→yearn), so filtering it would have no effect. Matches backtest exactly.
  const NON_ALPHA_SNAPSHOT_PROTOCOLS = new Set(['synthetix', '1inch'])

  eventBus.on('governance:snapshot', (event: GovernanceEvent) => {
    const snap = event as SnapshotProposalEvent
    if (NON_ALPHA_SNAPSHOT_PROTOCOLS.has(snap.protocol)) return

    log.debug({ title: snap.title, space: snap.space, state: snap.state }, 'Snapshot proposal detected')

    try {
      const analysis = analyzeSnapshotProposal(snap)
      recordSnapshot(snap, analysis ?? undefined)
      if (!analysis) return

      const snapCacheKey = `snapshot:${snap.protocol}:${snap.snapshotId ?? 'unknown'}`
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

// ─── Holding-Time Recovery ──────────────────────────────────────────

/**
 * Recover the real entry timestamp for a position after bot restart.
 * Queries /fapi/v1/allOrders to find the most recent FILLED MARKET entry order
 * (non-reduce-only) and uses its `time` as the positionHoldingMeta entryTime.
 * Falls back to 24h ago if no matching order is found.
 */
async function recoverHoldingMeta(symbol: string): Promise<void> {
  let entryTime = Date.now() - 24 * 3600_000 // conservative fallback: assume 24h old
  try {
    const { getOrderHistory } = await import('./clients/binance.js')
    const orders = await getOrderHistory(symbol, 50)
    // Find the most recent filled MARKET entry (not a close/reduce order)
    const entryOrder = orders
      .filter(o => o.status === 'FILLED' && o.type === 'MARKET' && !o.reduceOnly)
      .sort((a, b) => b.time - a.time)[0]
    if (entryOrder) {
      entryTime = entryOrder.time
      // Also update income-tracking start time so getIncome() at close covers the full range.
      // The fallback in position:update sets 720h; here we narrow it to the real entry.
      positionOpenTimeMs.set(symbol, entryTime)
      log.info(
        { symbol, entryTime: new Date(entryTime).toISOString() },
        'Max-holding-time tracking restored — real entry time from order history',
      )
    } else {
      log.info(
        { symbol },
        'Max-holding-time tracking restored — no MARKET entry order found, assuming 24h ago',
      )
    }
  } catch (err) {
    log.warn({ err, symbol }, 'Order history fetch failed — max-holding-time assumes 24h ago')
  }
  if (!positionHoldingMeta.has(symbol)) {
    positionHoldingMeta.set(symbol, { entryTime, maxHoldingHours: 720 })
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PRODUCTION BOT — GOVERNANCE LAYER ONLY
//
// This file starts EXACTLY these systems and nothing else:
//   1. DB + config validation
//   2. Reconcile ghost positions (startup DB vs Binance cross-check)
//   3. Analysis pipeline (governance event → proposal analysis)
//   4. Signal generator (analysis → trading signals)
//   5. Risk manager (position sizing, stop-loss, Kelly criterion)
//   6. Position tracker + price monitor
//   7. Governance monitors (on-chain WSS, forum, Snapshot)
//   8. Trade executor (Binance orders)
//   9. Keep-alive loop (health checks, Telegram reports)
//
// DO NOT add imports or start calls for bb-bounce, momentum, btc-trend,
// or any other trading layer here. Those are separate programs.
// Adding them here causes LIVE UNINTENDED TRADES on the server because
// old layer files persist on the server even after deletion from the repo
// (tar extract never removes files).
// ═══════════════════════════════════════════════════════════════════════════

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

  if (config.enableDependencyGraph) {
    try {
      await refreshGraph()
      log.info('Dependency graph initialized')
    } catch (err) {
      log.warn({ err }, 'Dependency graph initialization failed — continuing without cascade graph')
    }
  }

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

    // 2a. Reconcile layer DB positions against Binance — clears ghost positions
    // (positions closed externally during downtime or via manual trading)
    if (!config.dryRun) {
      const { reconcilePositions } = await import('./capital/reconcile.js')
      await reconcilePositions()
    }
  }

  // 4. Wire analysis pipeline (IDENTICAL to backtest wireAnalysisPipeline)
  wireAnalysisPipeline(riskManager)

  // 5. Wire signal generator (analysis → signals)
  // (matches backtest step 5: wireSignalGenerator(() => collector.getCurrentPositions()))
  wireSignalGenerator(() => currentPositions, true) // true = enable funding rate boost (live mode)

  // 6. Wire risk manager (signals → validated signals)
  // (matches backtest step 6: wireRiskManager(riskManager))
  wireRiskManager(riskManager)

  // 7. Wire position updates to risk manager + position close detection
  // (matches backtest step 7: eventBus.on('position:update', ...) → riskManager.updatePortfolio
  //  + live equivalent of ResultCollector.closeTrade for win/loss tracking)
  eventBus.on('position:update', (update) => {
    const newPositions = update.positions

    // ─── Position Open-Time Tracking (fallback) ────────────────────
    // execution:result already sets positionOpenTimeMs with a precise timestamp.
    // This fallback handles external positions (manual trades, positions open at bot start).
    const previousIds = new Set(previousPositions.map((p: Position) => p.id))
    for (const pos of newPositions) {
      if (!previousIds.has(pos.id) && pos.protocol === 'binance') {
        const symbol = pos.id.replace('binance:', '')
        if (!positionOpenTimeMs.has(symbol)) {
          // Wide fallback: cover full maxHoldingHours (720h) so getIncome() at close captures
          // entry commissions and all funding fees. recoverHoldingMeta() will narrow this to the
          // real entry time once the Binance order history is fetched (async, runs in parallel).
          positionOpenTimeMs.set(symbol, Date.now() - 720 * 3600_000)
        }
        // Restore max-holding-time tracking after bot restart.
        // execution:result sets this on new trades; if missing, the bot restarted
        // with an existing position. Query Binance order history for the real entry
        // timestamp so the 720h clock starts from the actual open, not from restart.
        if (!positionHoldingMeta.has(symbol)) {
          void recoverHoldingMeta(symbol)
        }
      }
    }

    // ─── Position Close Detection ──────────────────────────────────
    // Detect positions that disappeared (closed on exchange via SL/TP/manual)
    // and record win/loss — mirrors backtest ResultCollector.closeTrade()
    const currentIds = new Set(newPositions.map((p: Position) => p.id))
    for (const prev of previousPositions) {
      if (!currentIds.has(prev.id)) {
        const now = Date.now()

        // Determine PnL: prefer income history (accurate) over stale position fields.
        // realizedPnl on Binance open-position snapshots is always 0; unrealizedPnl
        // may be stale from the last poll and can carry the wrong sign at close time.
        const symbol = prev.protocol === 'binance' ? prev.id.replace('binance:', '') : null
        const openTime = symbol ? (positionOpenTimeMs.get(symbol) ?? now - 24 * 3600_000) : null

        let pnl: number = parseFloat(prev.unrealizedPnl || '0')

        if (symbol && openTime && config.binanceApiKey && config.binanceApiSecret) {
          // Fetch income history async — record ONCE with accurate PnL.
          // Do NOT record synchronously first: that would cause double-counting
          // because recordFromIncome also calls record* when income records exist.
          const holdingHours = (now - openTime) / 3_600_000
          void (async () => {
            let pnlToRecord = pnl // snapshot PnL as fallback
            try {
              const { getIncome } = await import('./clients/binance.js')
              // endTime = now + 5s buffer ensures the close income record is captured
              // while excluding income from any subsequent same-symbol position.
              const records = await getIncome({ symbol: symbol!, startTime: openTime, endTime: now + 5_000 })
              const incomePnl = records
                .filter(r => ['REALIZED_PNL', 'FUNDING_FEE', 'COMMISSION'].includes(r.incomeType))
                .reduce((sum, r) => sum + parseFloat(r.income), 0)
              if (records.length > 0) {
                pnlToRecord = incomePnl
                log.info(
                  { id: prev.id, asset: prev.asset, pnl: incomePnl.toFixed(2), records: records.length },
                  'Position closure recorded (income history)',
                )
              } else {
                log.debug({ symbol }, 'No income records — recording snapshot PnL')
              }
            } catch (err) {
              log.warn({ err, symbol }, 'Income history fetch failed — recording snapshot PnL')
            }
            // NOTE: 'margin' here is notional (size × entryPrice), not margin (notional/leverage).
            // recordTradeOutcome is diagnostic-only (adaptive Kelly is disabled in confidenceScorer),
            // so the imprecision has no effect on live sizing.
            const margin = Math.abs(parseFloat(prev.size || '0')) * parseFloat(prev.entryPrice || '0')
            if (margin > 0) recordTradeOutcome(pnlToRecord, margin)
            if (pnlToRecord < 0) { recordStopLoss(prev.asset, now); recordGlobalLoss(now) }
            else if (pnlToRecord > 0) { recordWin(prev.asset); resetGlobalLosses() }
            recordMonthlyPnl(now, pnlToRecord)
            // Telegram notification — mirrors trade_executed alert on entry
            const side = parseFloat(prev.size || '0') < 0 ? 'SHORT' : 'LONG'
            const pnlSign = pnlToRecord >= 0 ? '+' : ''
            sendAlert(
              'trade_exit', 'info',
              `Position Closed: ${side} ${prev.asset}`,
              `PnL: ${pnlSign}$${pnlToRecord.toFixed(2)}\nEntry: $${(() => { const p = parseFloat(prev.entryPrice || '0'); return p >= 1 ? p.toFixed(2) : p.toFixed(4) })()}\nHeld: ${holdingHours.toFixed(0)}h\nExit: Trailing Stop / SL / TP`,
            ).catch(() => {})
          })()
        } else {
          // No API keys or non-Binance: use snapshot fields as-is
          const realizedPnl = parseFloat(prev.realizedPnl || '0')
          if (realizedPnl !== 0) pnl = realizedPnl
          const margin = Math.abs(parseFloat(prev.size || '0')) * parseFloat(prev.entryPrice || '0')
          if (margin > 0) recordTradeOutcome(pnl, margin)
          if (pnl < 0) { recordStopLoss(prev.asset, now); recordGlobalLoss(now) }
          else if (pnl > 0) { recordWin(prev.asset); resetGlobalLosses() }
          recordMonthlyPnl(now, pnl)
          log.info(
            { id: prev.id, asset: prev.asset, pnl: pnl.toFixed(2), protocol: prev.protocol },
            'Position closure detected and recorded',
          )
        }

        // Cancel any remaining protective orders (SL / trailing-stop / TP)
        // on the closed symbol so they don't interfere with future positions.
        // Also remove from governance stage-tracking to prevent stale reductions.
        if (prev.protocol === 'binance' && symbol) {
          positionOpenTimeMs.delete(symbol)
          positionHoldingMeta.delete(symbol)
          clearProtectionState(symbol)
          riskManager.untrackPosition(prev.id)
          cancelPositionOrders(symbol).catch((err) => {
            log.warn({ err, symbol }, 'Order cleanup after position close failed')
            sendAlert('system_error', 'error', 'Order Cleanup Failed',
              `Failed to cancel protective orders for ${symbol} after position close. Old orders may interfere with next trade.`,
            ).catch(() => {})
          })
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

  // 8a. Track execution results for max-holding-time + stage-transition management.
  // When a trade executes (dry-run or live):
  //   - record entry time for max-holding-time exit
  //   - register position in RiskManager so stage transitions can trigger reductions
  eventBus.on('execution:result', (result: ExecutionResult) => {
    if (!result.success) return
    const symbol = result.metadata?.symbol as string | undefined
    const maxHoldingHours = result.metadata?.maxHoldingHours as number | undefined
    const proposalId = result.metadata?.proposalId as string | undefined
    const asset = result.metadata?.asset as string | undefined
    if (!symbol) return

    // Max-holding-time tracking — only when maxHoldingHours is set and non-zero
    if (maxHoldingHours) {
      positionHoldingMeta.set(symbol, { entryTime: Date.now(), maxHoldingHours })
      log.debug({ symbol, maxHoldingHours }, 'Position entry recorded — max-holding-time tracking active')
    }

    // Governance stage-transition tracking — independent of maxHoldingHours.
    // Register with RiskManager so stage transitions (queued/executed/canceled) can reduce/close.
    // currentSizePct=100 means "full position open" on the 0-100 scale used by STAGE_LIMITS.
    if (proposalId && asset) {
      riskManager.trackPosition(proposalId, `binance:${symbol}`, asset, 100)
      log.debug({ proposalId, symbol }, 'Position tracked for stage-transition management')
    }

    // Record precise open time for income-history PnL lookup at close.
    // result.timestamp is set at order submission — more accurate than position-update poll time.
    positionOpenTimeMs.set(symbol, result.timestamp)
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

  // 13. Keep alive + max-holding-time monitor
  // IMPORTANT: running = true must be set before starting loops that use `while (running)`
  running = true
  maxHoldingTimeMonitor().catch((err) => {
    log.error({ err }, 'Max-holding-time monitor crashed')
  })
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
        await reduceAndRearm(symbol, pos.size, 100)
        positionHoldingMeta.delete(symbol)
        log.info({ symbol }, 'Max-holding-time close executed')
      } catch (err) {
        log.error({ err, symbol }, 'Max-holding-time close failed — will retry in 30 min')
      }
    }
  }
}

// ─── Keep-Alive Loop ────────────────────────────────────────────────

// Track last heap alert to avoid spamming (max once per 30 min)
let lastHeapAlertMs = 0
// Track last weekly report by date string (YYYY-MM-DD) to send exactly once per Monday
let lastWeeklyReportDate = ''

async function keepAliveLoop(): Promise<void> {
  while (running) {
    await sleep(60_000)
    log.debug({ positions: currentPositions.length }, 'Keep-alive tick')

    // ─── Heap Memory Alert (every 30 min) ───────────────────────────
    const now = Date.now()
    if (now - lastHeapAlertMs >= 30 * 60_000) {
      lastHeapAlertMs = now
      const mem = process.memoryUsage()
      const heapPct = mem.heapUsed / mem.heapTotal
      // Only alert once heapTotal > 200MB — avoids false positive at startup when
      // Node.js V8 begins with a tiny heap (32MB) that grows dynamically.
      // A 93% reading on a 32MB heap is meaningless; only a 90%+ reading on a
      // substantial heap (>200MB) indicates real OOM risk.
      if (heapPct > 0.90 && mem.heapTotal > 200 * 1048576) {
        log.warn({ heapUsedMb: (mem.heapUsed / 1048576).toFixed(0), heapTotalMb: (mem.heapTotal / 1048576).toFixed(0), heapPct: (heapPct * 100).toFixed(1) + '%' }, 'Heap memory critical (>90%)')
        sendAlert('system_health', 'error', 'Heap Memory Critical', `Heap: ${(heapPct * 100).toFixed(1)}% used (${(mem.heapUsed / 1048576).toFixed(0)}/${(mem.heapTotal / 1048576).toFixed(0)} MB)\nBot may become unstable. Consider restarting.`).catch(() => {})
      }
    }

    // ─── Weekly Telegram Report (Monday 08:00 UTC) ───────────────────
    const d = new Date()
    const isMonday = d.getUTCDay() === 1
    const isReportHour = d.getUTCHours() === 8
    const todayStr = d.toISOString().slice(0, 10)
    if (isMonday && isReportHour && lastWeeklyReportDate !== todayStr) {
      lastWeeklyReportDate = todayStr
      try {
        const { getAccountInfo } = await import('./clients/binance.js')
        const acc = await getAccountInfo()
        const wallet = parseFloat(acc.totalWalletBalance).toFixed(2)
        const upnl = parseFloat(acc.totalUnrealizedProfit).toFixed(2)
        const openCount = currentPositions.length
        const upnlSign = parseFloat(upnl) >= 0 ? '+' : ''
        await sendAlert(
          'system_health', 'info',
          `Weekly Report — ${todayStr}`,
          `Wallet: $${wallet}\nUnrealized PnL: ${upnlSign}$${upnl}\nOpen positions: ${openCount}\n\nBot running normally.`,
        )
        log.info({ wallet, upnl, openCount }, 'Weekly report sent')
      } catch (err) {
        log.warn({ err }, 'Weekly report failed')
      }
    }
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
