/**
 * DeFi Governance Alpha Bot — Main Entry Point
 *
 * Orchestrates all layers:
 *   Monitoring → Analysis → Signal Generation → Risk Management → Execution → Alerts
 *
 * Initialization order (dependency graph):
 *   1. Config + Store (Layer 0)
 *   2. RPC clients (Layer 1a)
 *   3. Governance monitors + API clients (Layer 1b/1c)
 *   4. Proposal analyzer + Position tracker + Price monitor (Layer 2)
 *   5. Signal generator + Risk manager (Layer 3)
 *   6. Trade executor + Alert service (Layer 4)
 *   7. Event bus wiring + Health checks (Layer 5)
 */
import { config } from './config/index.js'
import { initStore, closeStore, getActiveProposals } from './lib/store.js'
import { createLogger } from './lib/logger.js'
import { eventBus } from './lib/eventBus.js'
import { sleep } from './lib/retry.js'

// Layer 1 — Monitors
import { startAllMonitors, stopAllMonitors } from './monitor/index.js'

// Layer 2 — Analysis
import { decodeGovernorBravoActions } from './analysis/proposalDecoder.js'
import { classifyProposal, getImpactCategories } from './analysis/proposalClassifier.js'
import { buildDependencyGraph, getGraph, refreshGraph } from './analysis/dependencyGraph.js'
import { simulateLtChange } from './analysis/liquidationSim.js'
import { fetchAndParseSpell } from './analysis/spellParser.js'

// Layer 2 — Processing
import { startPositionTracker, stopPositionTracker, refreshPositions, setWalletAddress } from './processing/positionTracker.js'
import { startPriceMonitor, stopPriceMonitor, getPrice } from './processing/priceMonitor.js'

// Layer 3 — Strategy
import { wireSignalGenerator, generateSignals } from './strategy/signalGenerator.js'
import { RiskManager, wireRiskManager } from './strategy/riskManager.js'

// Layer 4 — Execution
import { wireTradeExecutor } from './execution/tradeExecutor.js'
import { startAlertService, sendAlert } from './execution/alertService.js'

import { upsertProposal } from './lib/store.js'
import type { ProposalCreatedEvent, GovernanceEvent, ProposalAnalysis } from './types/governance.js'
import type { Position } from './types/trading.js'

const log = createLogger('main')

// ─── Global State ───────────────────────────────────────────────────

let running = false
let riskManager: RiskManager
let currentPositions: Position[] = []

// ─── Analysis Pipeline ──────────────────────────────────────────────

/**
 * Process a new governance proposal event through the full analysis pipeline.
 */
async function analyzeProposal(event: GovernanceEvent): Promise<void> {
  if (event.type !== 'proposal_created') return

  const proposal = event as ProposalCreatedEvent

  try {
    // 1. Decode proposal actions
    let actions = decodeGovernorBravoActions(proposal)

    // For Maker spells, try to parse source code
    if (proposal.protocol === 'maker' && proposal.targets.length > 0) {
      const spellActions = await fetchAndParseSpell(proposal.targets[0])
      if (spellActions.length > 0) {
        actions = spellActions
      }
    }

    // 2. Classify impacts
    const impacts = classifyProposal(actions)
    const categories = getImpactCategories(actions)

    // 3. Find cascade impacts
    const graph = getGraph()
    let cascadeImpacts = impacts.flatMap((impact) => {
      const nodeId = `${proposal.protocol}:${impact.asset.toLowerCase()}`
      if (!graph.getNode(nodeId)) return []
      return graph.findCascadeImpacts(nodeId, {
        param: impact.category,
        oldValue: impact.currentValue ?? '',
        newValue: impact.proposedValue ?? '',
      })
    })

    // 4. Run liquidation simulation for LT changes
    for (const impact of impacts) {
      if (
        (impact.category === 'liquidation_threshold_change' || impact.category === 'ltv_change') &&
        impact.currentValue &&
        impact.proposedValue
      ) {
        try {
          const simResult = await simulateLtChange(
            parseInt(impact.currentValue),
            parseInt(impact.proposedValue),
            impact.asset,
          )
          log.info(
            {
              asset: impact.asset,
              affectedPositions: simResult.affectedPositions,
              totalAtRisk: simResult.totalAtRiskUsd,
            },
            'Liquidation simulation complete',
          )
        } catch (err) {
          log.debug({ err }, 'Liquidation simulation skipped')
        }
      }
    }

    // 5. Build ProposalAnalysis
    const analysis: ProposalAnalysis = {
      proposalId: proposal.proposalId.toString(),
      protocol: proposal.protocol,
      stage: 'onchain_vote',
      title: proposal.description.slice(0, 200),
      description: proposal.description,
      actions,
      impacts,
      cascadeImpacts,
      confidenceScore: 0.5,
      timestamp: Date.now(),
    }

    // 6. Persist proposal
    upsertProposal({
      id: `${proposal.protocol}:${proposal.proposalId}`,
      protocol: proposal.protocol,
      stage: 'onchain_vote',
      title: proposal.description.slice(0, 200),
      classification: categories,
      analysis: JSON.stringify(analysis),
    })

    // 7. Emit analysis for signal generation
    eventBus.emit('analysis:proposal', analysis)

    // 8. Alert
    await sendAlert(
      'proposal_detected',
      impacts.some((i) => i.severity === 'critical') ? 'critical' : 'info',
      `New Proposal: ${proposal.protocol.toUpperCase()} #${proposal.proposalId}`,
      [
        `Title: ${proposal.description.slice(0, 100)}`,
        `Actions: ${actions.length}`,
        `Impacts: ${impacts.map((i) => i.category).join(', ') || 'none classified'}`,
        `Cascade effects: ${cascadeImpacts.length}`,
      ].join('\n'),
      {
        proposalId: proposal.proposalId.toString(),
        protocol: proposal.protocol,
        categories: categories.join(', '),
      },
    )
  } catch (err) {
    log.error({ err, proposalId: proposal.proposalId.toString() }, 'Proposal analysis failed')
  }
}

// ─── Stage Transition Handler ───────────────────────────────────────

function handleStageTransition(event: GovernanceEvent): void {
  let proposalId: string | undefined
  let newStage: string | undefined

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

  // Update stored proposal stage
  upsertProposal({ id: proposalId, protocol: event.protocol, stage: newStage })

  // Trigger risk manager stage transition for position reduction
  if (newStage !== 'canceled') {
    const reductions = riskManager.handleStageTransition(
      proposalId,
      newStage as any,
    )

    for (const reduction of reductions) {
      log.info(
        { positionId: reduction.positionId, reduceByPct: reduction.reduceByPct },
        'Stage transition — reducing position',
      )
    }
  }

  sendAlert(
    'stage_transition',
    newStage === 'executed' ? 'warning' : 'info',
    `Proposal Stage: ${newStage.toUpperCase()}`,
    `Proposal ${proposalId} moved to ${newStage}`,
    { proposalId, stage: newStage },
  ).catch(() => {})
}

// ─── Health Check ───────────────────────────────────────────────────

async function runHealthCheck(): Promise<void> {
  try {
    // Check RPC connectivity
    const { getReadClient } = await import('./clients/rpc.js')
    const client = getReadClient()
    const blockNumber = await client.getBlockNumber()

    eventBus.emit('system:health', {
      module: 'rpc',
      status: 'ok',
      message: `Block: ${blockNumber}`,
    })

    // Check active proposals
    const proposals = getActiveProposals()

    log.info(
      {
        blockNumber: blockNumber.toString(),
        activeProposals: proposals.length,
        trackedPositions: currentPositions.length,
      },
      'Health check OK',
    )
  } catch (err) {
    eventBus.emit('system:health', {
      module: 'rpc',
      status: 'down',
      message: err instanceof Error ? err.message : 'Unknown error',
    })
    log.error({ err }, 'Health check failed')
  }
}

// ─── Main Boot Sequence ─────────────────────────────────────────────

async function main(): Promise<void> {
  log.info('╔══════════════════════════════════════════════╗')
  log.info('║   DeFi Governance Alpha Bot — Starting...    ║')
  log.info('╚══════════════════════════════════════════════╝')

  // 1. Initialize database
  initStore()
  log.info('Database initialized')

  // 2. Initialize risk manager
  riskManager = new RiskManager()

  // 3. Set wallet address if configured
  if (config.ethPrivateKey) {
    try {
      const { getWalletAddress } = await import('./clients/rpc.js')
      const address = getWalletAddress()
      setWalletAddress(address)
      log.info({ address }, 'Wallet configured')
    } catch (err) {
      log.warn('No wallet configured — running in monitor-only mode')
    }
  }

  // 4. Wire event bus (Layer 5 wiring)
  //    Governance events → Analysis pipeline
  eventBus.on('governance:proposal', (event) => {
    analyzeProposal(event).catch((err) => log.error({ err }, 'Analysis pipeline error'))
  })

  eventBus.on('governance:queued', handleStageTransition)
  eventBus.on('governance:executed', handleStageTransition)
  eventBus.on('governance:canceled', handleStageTransition)

  //    Snapshot proposals
  eventBus.on('governance:snapshot', (event) => {
    sendAlert(
      'proposal_detected',
      'info',
      `Snapshot Proposal: ${(event as any).title ?? 'New proposal'}`,
      `Space: ${(event as any).space ?? 'unknown'}\nState: ${(event as any).state ?? 'active'}`,
    ).catch(() => {})
  })

  //    Forum posts
  eventBus.on('governance:forum', (event) => {
    log.info({ event: event.type }, 'Forum activity detected')
  })

  //    Whale movements
  eventBus.on('whale:delegation', (event) => {
    if (event.type === 'delegate_votes_changed') {
      sendAlert(
        'whale_movement',
        'warning',
        'Significant Delegation Change',
        `Token: ${(event as any).token}\nDelegate: ${(event as any).delegate}`,
      ).catch(() => {})
    }
  })

  //    Position updates → risk manager
  eventBus.on('position:update', (update) => {
    currentPositions = update.positions
    riskManager.updatePortfolio(currentPositions, 0) // Portfolio value TBD
  })

  // 5. Wire signal generator (analysis → signals)
  wireSignalGenerator(() => currentPositions)

  // 6. Wire risk manager (signals → validated signals)
  wireRiskManager(riskManager)

  // 7. Wire trade executor (validated signals → execution)
  wireTradeExecutor()

  // 8. Start alert service
  startAlertService()

  // 9. Build dependency graph
  try {
    await buildDependencyGraph()
    log.info('Dependency graph built')
  } catch (err) {
    log.warn({ err }, 'Dependency graph build failed — continuing without cascade analysis')
  }

  // 10. Start all monitors
  await startAllMonitors()

  // 11. Start price monitor
  startPriceMonitor()

  // 12. Start position tracker
  startPositionTracker()

  // 13. Start periodic health checks and graph refresh
  running = true
  healthCheckLoop().catch((err) => log.error({ err }, 'Health check loop crashed'))

  // 14. Startup alert
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

// ─── Health Check Loop ──────────────────────────────────────────────

async function healthCheckLoop(): Promise<void> {
  while (running) {
    await sleep(60_000) // Check every 60s
    await runHealthCheck()

    // Refresh dependency graph every 15 minutes
    const now = Date.now()
    if (now % (15 * 60_000) < 60_000) {
      try {
        await refreshGraph()
        log.debug('Dependency graph refreshed')
      } catch (err) {
        log.debug({ err }, 'Graph refresh failed')
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

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'Uncaught exception')
  shutdown('uncaughtException').catch(() => process.exit(1))
})
process.on('unhandledRejection', (reason) => {
  log.error({ reason }, 'Unhandled rejection')
})

// ─── Start ──────────────────────────────────────────────────────────

main().catch((err) => {
  log.fatal({ err }, 'Fatal startup error')
  process.exit(1)
})
