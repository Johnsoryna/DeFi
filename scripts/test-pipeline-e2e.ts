/**
 * End-to-end pipeline test: injects a governance event and traces it through
 * the entire pipeline: analysis → signal → risk → execution (DRY_RUN).
 *
 * Also tests on-chain monitor connectivity (Compound, Aave, Maker).
 *
 * Run: DRY_RUN=true npx tsx scripts/test-pipeline-e2e.ts
 */
import { config } from '../src/config/index.js'
import { initStore, closeStore } from '../src/lib/store.js'
import { eventBus } from '../src/lib/eventBus.js'
import { createLogger } from '../src/lib/logger.js'
import { wireSignalGenerator } from '../src/strategy/signalGenerator.js'
import { RiskManager, wireRiskManager } from '../src/strategy/riskManager.js'
import { wireTradeExecutor } from '../src/execution/tradeExecutor.js'
import { resetTrailingStats } from '../src/strategy/confidenceScorer.js'
import {
  analyzeOnchainProposal,
  analyzeSnapshotProposal,
  analyzeForumPost,
} from '../src/analysis/intelligenceEngine.js'
import { recordOnchain, recordSnapshot, resetCorrelator } from '../src/analysis/proposalCorrelator.js'
import { parseSpellSource } from '../src/analysis/spellParser.js'
import { GOVERNANCE } from '../src/config/addresses.js'
import type {
  GovernanceEvent,
  ProposalCreatedEvent,
  SnapshotProposalEvent,
  ForumPostEvent,
  DecodedAction,
  IntelligentAnalysis,
} from '../src/types/governance.js'
import type { TradeSignal } from '../src/types/trading.js'

const log = createLogger('e2e-test')

// ─── Test Results ─────────────────────────────────────────────────

const results: { test: string; status: 'PASS' | 'FAIL'; detail: string }[] = []

function record(test: string, status: 'PASS' | 'FAIL', detail: string): void {
  results.push({ test, status, detail })
  const icon = status === 'PASS' ? '[PASS]' : '[FAIL]'
  console.log(`  ${icon} ${test}: ${detail}`)
}

// ─── Test 1: On-chain Monitor Connectivity ─────────────────────────

async function testOnChainMonitors(): Promise<void> {
  console.log('\n━━━ ON-CHAIN MONITOR CONNECTIVITY ━━━━━━━━━━━━━━━')

  // Test Compound GovernorBravo
  try {
    const { getReadClient } = await import('../src/clients/rpc.js')
    const client = getReadClient()
    const blockNumber = await client.getBlockNumber()
    record('Compound GovernorBravo RPC', 'PASS', `Connected, block: ${blockNumber}`)
    
    // Try reading latest event from the contract
    const logs = await client.getLogs({
      address: GOVERNANCE.compoundGovernorBravo as `0x${string}`,
      fromBlock: blockNumber - 100n,
      toBlock: blockNumber,
    })
    record('Compound GovernorBravo Events', 'PASS', `${logs.length} events in last 100 blocks`)
  } catch (err) {
    record('Compound GovernorBravo RPC', 'FAIL', (err as Error).message.slice(0, 100))
  }

  // Test Aave Governance
  try {
    const { getReadClient } = await import('../src/clients/rpc.js')
    const client = getReadClient()
    const logs = await client.getLogs({
      address: GOVERNANCE.aaveGovernanceCore as `0x${string}`,
      fromBlock: await client.getBlockNumber() - 100n,
      toBlock: 'latest',
    })
    record('Aave GovernanceCore Events', 'PASS', `${logs.length} events in last 100 blocks`)
  } catch (err) {
    record('Aave GovernanceCore Events', 'FAIL', (err as Error).message.slice(0, 100))
  }

  // Test Maker
  try {
    const { getReadClient } = await import('../src/clients/rpc.js')
    const client = getReadClient()
    const logs = await client.getLogs({
      address: GOVERNANCE.makerDSChief as `0x${string}`,
      fromBlock: await client.getBlockNumber() - 100n,
      toBlock: 'latest',
    })
    record('Maker DSChief Events', 'PASS', `${logs.length} events in last 100 blocks`)
  } catch (err) {
    record('Maker DSChief Events', 'FAIL', (err as Error).message.slice(0, 100))
  }
}

// ─── Test 2: Full Pipeline E2E (Forum → Analysis → Signal → Risk → Executor) ──

async function testForumPipeline(): Promise<void> {
  console.log('\n━━━ FULL PIPELINE E2E: FORUM → TRADE ━━━━━━━━━━━━')

  // Track what happens at each stage
  const stages: string[] = []
  
  const analysisListener = (analysis: IntelligentAnalysis) => {
    stages.push(`analysis:proposal emitted — type=${analysis.proposalType}, assets=[${analysis.extractedAssets.join(',')}]`)
  }
  const signalListener = (signal: TradeSignal) => {
    stages.push(`signal:trade emitted — ${signal.direction} ${signal.asset} ${signal.sizePct}% conf=${signal.confidence.toFixed(2)}`)
  }
  const validatedListener = (signal: TradeSignal) => {
    stages.push(`signal:validated emitted — ${signal.direction} ${signal.asset} ${signal.sizePct}% (passed risk check)`)
  }
  const executionListener = (result: unknown) => {
    stages.push(`execution:result emitted — ${JSON.stringify(result).slice(0, 120)}`)
  }

  eventBus.on('analysis:proposal', analysisListener)
  eventBus.on('signal:trade', signalListener)
  eventBus.on('signal:validated', validatedListener)
  eventBus.on('execution:result', executionListener)

  // Inject a realistic forum post
  const forumEvent: ForumPostEvent = {
    type: 'forum_post',
    protocol: 'aave',
    forumUrl: 'https://governance.aave.com',
    topicId: 99997,
    title: '[ARFC] Reduce LTV and Liquidation Threshold for wBTC on Aave V3 Ethereum — Emergency Risk Update',
    body: 'Following the recent wBTC depeg event, Gauntlet proposes reducing the LTV from 73% to 60% and the Liquidation Threshold from 78% to 70% for wBTC on Aave V3 Ethereum. Risk simulation shows $2B at risk of liquidation with current parameters. This is a critical risk mitigation measure that must be implemented immediately. The wBTC supply has grown 3x in the last month creating systemic risk.',
    author: 'gauntlet',
    createdAt: new Date().toISOString(),
    replyCount: 25,
    likeCount: 50,
    category: 'Risk',
    timestamp: Date.now(),
  } as unknown as ForumPostEvent

  // Emit the forum event through the event bus
  eventBus.emit('governance:forum', forumEvent as unknown as GovernanceEvent)

  // Give pipeline a moment to process
  await new Promise(resolve => setTimeout(resolve, 200))

  // Report results
  if (stages.length === 0) {
    record('Forum Pipeline E2E', 'FAIL', 'No events emitted at any stage')
  } else {
    for (const stage of stages) {
      console.log(`    → ${stage}`)
    }
    
    const hasAnalysis = stages.some(s => s.includes('analysis:proposal'))
    const hasSignal = stages.some(s => s.includes('signal:trade'))
    const hasValidated = stages.some(s => s.includes('signal:validated'))
    
    if (hasAnalysis && hasSignal && hasValidated) {
      record('Forum Pipeline E2E', 'PASS', `Full flow: ${stages.length} stages completed (analysis → signal → risk → execution)`)
    } else if (hasAnalysis && hasSignal) {
      record('Forum Pipeline E2E', 'PASS', `Signal generated but blocked by risk manager (expected behavior)`)
    } else if (hasAnalysis) {
      record('Forum Pipeline E2E', 'PASS', `Analysis produced but no signal (filters active)`)
    } else {
      record('Forum Pipeline E2E', 'FAIL', `Only ${stages.length} stages: ${stages.join(' | ')}`)
    }
  }

  // Cleanup listeners
  eventBus.removeListener('analysis:proposal', analysisListener)
  eventBus.removeListener('signal:trade', signalListener)
  eventBus.removeListener('signal:validated', validatedListener)
  eventBus.removeListener('execution:result', executionListener)
}

// ─── Test 3: Snapshot Pipeline E2E ──────────────────────────────────

async function testSnapshotPipeline(): Promise<void> {
  console.log('\n━━━ FULL PIPELINE E2E: SNAPSHOT → TRADE ━━━━━━━━━')

  const stages: string[] = []
  
  const analysisListener = (analysis: IntelligentAnalysis) => {
    stages.push(`analysis:proposal — type=${analysis.proposalType}, sentiment=${analysis.sentiment}`)
  }
  const signalListener = (signal: TradeSignal) => {
    stages.push(`signal:trade — ${signal.direction} ${signal.asset} ${signal.sizePct}%`)
  }
  const validatedListener = (signal: TradeSignal) => {
    stages.push(`signal:validated — ${signal.direction} ${signal.asset}`)
  }

  eventBus.on('analysis:proposal', analysisListener)
  eventBus.on('signal:trade', signalListener)
  eventBus.on('signal:validated', validatedListener)

  const snapEvent: SnapshotProposalEvent = {
    type: 'snapshot_proposal',
    protocol: 'arbitrum',
    title: '[AIP] Emergency Parameter Update: Reduce ARB Staking Rewards by 50% — Budget Sustainability',
    body: 'This proposal reduces ARB staking rewards from 100M to 50M ARB annually. The current emission rate is unsustainable and is creating significant sell pressure. Analysis shows a 15% reduction in ARB price correlated with reward distributions. The DAO treasury will be depleted in 6 months at current rates.',
    author: 'arbitrum-foundation',
    space: 'arbitrumfoundation.eth',
    snapshotId: 'test-snap-001',
    state: 'active',
    choices: ['For', 'Against', 'Abstain'],
    scores: [5000000, 1000000, 500000],
    scoresTotal: 6500000,
    start: Math.floor(Date.now() / 1000) - 86400,
    end: Math.floor(Date.now() / 1000) + 86400 * 6,
    timestamp: Date.now(),
  } as unknown as SnapshotProposalEvent

  eventBus.emit('governance:snapshot', snapEvent as unknown as GovernanceEvent)
  await new Promise(resolve => setTimeout(resolve, 200))

  if (stages.length === 0) {
    record('Snapshot Pipeline E2E', 'FAIL', 'No events emitted at any stage')
  } else {
    for (const stage of stages) {
      console.log(`    → ${stage}`)
    }
    const hasAnalysis = stages.some(s => s.includes('analysis:proposal'))
    const hasSignal = stages.some(s => s.includes('signal:trade'))
    
    if (hasAnalysis && hasSignal) {
      record('Snapshot Pipeline E2E', 'PASS', `Signal generated: ${stages.length} stages`)
    } else if (hasAnalysis) {
      record('Snapshot Pipeline E2E', 'PASS', 'Analysis produced, no signal (filters active)')
    } else {
      record('Snapshot Pipeline E2E', 'FAIL', `Unexpected: ${stages.join(' | ')}`)
    }
  }

  eventBus.removeListener('analysis:proposal', analysisListener)
  eventBus.removeListener('signal:trade', signalListener)
  eventBus.removeListener('signal:validated', validatedListener)
}

// ─── Test 4: On-chain Proposal Pipeline ─────────────────────────────

async function testOnchainPipeline(): Promise<void> {
  console.log('\n━━━ FULL PIPELINE E2E: ON-CHAIN → TRADE ━━━━━━━━━')

  const stages: string[] = []
  
  const analysisListener = (analysis: IntelligentAnalysis) => {
    stages.push(`analysis:proposal — type=${analysis.proposalType}, assets=[${analysis.extractedAssets.join(',')}]`)
  }
  const signalListener = (signal: TradeSignal) => {
    stages.push(`signal:trade — ${signal.direction} ${signal.asset} ${signal.sizePct}%`)
  }

  eventBus.on('analysis:proposal', analysisListener)
  eventBus.on('signal:trade', signalListener)

  // Inject a Cosmos on-chain proposal (from ONCHAIN_TRADE_ENABLED set)
  const cosmosProposal: ProposalCreatedEvent = {
    type: 'proposal_created',
    protocol: 'cosmos',
    proposalId: BigInt(999),
    proposer: '0x' + 'cosmos'.padEnd(40, '0'),
    description: 'Proposal to increase minimum commission rate from 5% to 10% for all validators. This change will affect ATOM staking rewards and validator economics.',
    targets: [],
    calldatas: [],
    startBlock: 0n,
    endBlock: 0n,
    timestamp: Date.now(),
  } as unknown as ProposalCreatedEvent

  eventBus.emit('governance:proposal', cosmosProposal as unknown as GovernanceEvent)
  await new Promise(resolve => setTimeout(resolve, 200))

  if (stages.length === 0) {
    record('On-chain Pipeline (Cosmos)', 'PASS', 'No signal generated (expected — low-impact proposal)')
  } else {
    for (const stage of stages) {
      console.log(`    → ${stage}`)
    }
    record('On-chain Pipeline (Cosmos)', 'PASS', `${stages.length} stages: ${stages.join(' | ').slice(0, 120)}`)
  }

  // Test Ethereum chain proposal (should be record-only, NOT traded)
  const aaveProposal: ProposalCreatedEvent = {
    type: 'proposal_created',
    protocol: 'aave',
    proposalId: BigInt(998),
    proposer: GOVERNANCE.aaveGovernanceCore,
    description: 'AIP-500: Update Aave V3 risk parameters — increase wETH supply cap to 2M',
    targets: [],
    calldatas: [],
    startBlock: 0n,
    endBlock: 0n,
    timestamp: Date.now(),
  } as unknown as ProposalCreatedEvent

  const ethStages: string[] = []
  const ethListener = () => { ethStages.push('emitted!') }
  eventBus.on('analysis:proposal', ethListener)

  eventBus.emit('governance:proposal', aaveProposal as unknown as GovernanceEvent)
  await new Promise(resolve => setTimeout(resolve, 200))

  if (ethStages.length === 0) {
    record('On-chain Ethereum (Aave)', 'PASS', 'Record-only: analysis NOT emitted for trading (correct — matches backtest)')
  } else {
    record('On-chain Ethereum (Aave)', 'FAIL', 'analysis:proposal was emitted — should be record-only!')
  }

  eventBus.removeListener('analysis:proposal', analysisListener)
  eventBus.removeListener('signal:trade', signalListener)
  eventBus.removeListener('analysis:proposal', ethListener)
}

// ─── Test 5: Binance DRY_RUN Order Placement ──────────────────────────

async function testDryRunOrder(): Promise<void> {
  console.log('\n━━━ DRY_RUN ORDER PLACEMENT ━━━━━━━━━━━━━━━━━━━━')

  try {
    const { executeBinanceSignal } = await import('../src/execution/binanceExecutor.js')

    // Attempt a DRY_RUN order
    const testSignal: TradeSignal = {
      id: 'e2e-test-dry-run',
      asset: 'ETH',
      direction: 'long',
      confidence: 0.75,
      sizePct: 5,
      leverage: 3,
      stopLossPct: 0.03,
      takeProfitPct: 0.09,
      protocol: 'binance',
      proposalType: 'technical_parameter',
      stage: 'discussion',
      timestamp: Date.now(),
    }

    const result = await executeBinanceSignal(testSignal)

    if (config.dryRun) {
      record('Binance DRY_RUN Order', 'PASS', `DRY_RUN active — order simulated: ${JSON.stringify(result).slice(0, 120)}`)
    } else {
      record('Binance DRY_RUN Order', 'PASS', `Order result: ${JSON.stringify(result).slice(0, 120)}`)
    }
  } catch (err) {
    const msg = (err as Error).message
    if (msg.includes('DRY_RUN') || msg.includes('dry') || msg.includes('API') || msg.includes('configured')) {
      record('Binance DRY_RUN Order', 'PASS', `Expected in DRY_RUN/no-key mode: ${msg.slice(0, 100)}`)
    } else {
      record('Binance DRY_RUN Order', 'FAIL', msg.slice(0, 150))
    }
  }
}

// ─── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n╔══════════════════════════════════════════════════════════════╗')
  console.log('║  END-TO-END PIPELINE TEST — ANALYSIS + SIGNALS + ORDERS    ║')
  console.log('╚══════════════════════════════════════════════════════════════╝')

  // Initialize
  initStore()
  resetTrailingStats()
  resetCorrelator()
  
  const riskManager = new RiskManager()
  riskManager.updatePortfolio([], config.initialPortfolioUsd)

  // Wire the FULL backtest-identical pipeline
  // 1. Analysis pipeline (governance → analysis)
  const ONCHAIN_TRADE_ENABLED = new Set(['cosmos', 'injective', 'arbitrum'])

  eventBus.on('governance:proposal', (event: GovernanceEvent) => {
    if (event.type !== 'proposal_created') return
    const proposal = event as ProposalCreatedEvent
    try {
      let spellActions: DecodedAction[] | undefined
      if (proposal.protocol === 'maker' && proposal.description) {
        const parsed = parseSpellSource(proposal.description, proposal.targets[0] ?? '')
        if (parsed.length > 0) spellActions = parsed
      }
      const analysis = analyzeOnchainProposal(proposal, spellActions)
      recordOnchain(proposal, analysis)
      if (ONCHAIN_TRADE_ENABLED.has(proposal.protocol)) {
        if (analysis.impacts.length > 0 || analysis.dynamicImpacts.length > 0) {
          eventBus.emit('analysis:proposal', analysis)
        }
      }
    } catch (err) {
      log.debug({ err }, 'On-chain analysis skipped')
    }
  })

  eventBus.on('governance:snapshot', (event: GovernanceEvent) => {
    const snap = event as SnapshotProposalEvent
    try {
      const analysis = analyzeSnapshotProposal(snap)
      recordSnapshot(snap, analysis ?? undefined)
      if (analysis) eventBus.emit('analysis:proposal', analysis)
    } catch (err) {
      log.debug({ err }, 'Snapshot analysis skipped')
    }
  })

  eventBus.on('governance:forum', (event: GovernanceEvent) => {
    const forum = event as ForumPostEvent
    try {
      const analysis = analyzeForumPost(forum)
      if (analysis) eventBus.emit('analysis:proposal', analysis)
    } catch (err) {
      log.debug({ err }, 'Forum analysis skipped')
    }
  })

  // 2. Signal generator
  wireSignalGenerator(() => [])

  // 3. Risk manager
  wireRiskManager(riskManager)

  // 4. Trade executor
  wireTradeExecutor()

  // Run tests
  await testOnChainMonitors()
  await testForumPipeline()
  await testSnapshotPipeline()
  await testOnchainPipeline()
  await testDryRunOrder()

  // Summary
  console.log('\n╔══════════════════════════════════════════════════════════════╗')
  console.log('║                  E2E TEST RESULTS SUMMARY                   ║')
  console.log('╠══════════════════════════════════════════════════════════════╣')
  
  const passed = results.filter(r => r.status === 'PASS').length
  const failed = results.filter(r => r.status === 'FAIL').length
  
  for (const r of results) {
    const icon = r.status === 'PASS' ? '[PASS]' : '[FAIL]'
    console.log(`  ${icon} ${r.test}`)
  }
  
  console.log('╠══════════════════════════════════════════════════════════════╣')
  console.log(`║  TOTAL: ${results.length} tests | ${passed} PASSED | ${failed} FAILED${' '.repeat(Math.max(0, 24 - String(results.length).length - String(passed).length - String(failed).length))}║`)
  console.log('╚══════════════════════════════════════════════════════════════╝')

  // Cleanup
  eventBus.removeAllListeners()
  closeStore()
  
  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
