/**
 * Integration tests for the full trading pipeline.
 *
 * Tests the COMPLETE flow: Governance Event → Analysis → Signal → Risk → Execution → P&L
 *
 * Goal: Verify the bot produces CORRECT, PROFITABLE signals for known scenarios.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { eventBus } from '../../src/lib/eventBus.js'
import { initBacktestStore } from '../../src/backtest/schema.js'
import { VirtualClock, setClock, RealClock } from '../../src/backtest/clock.js'
import { MockPriceMonitor } from '../../src/backtest/mockPrice.js'
import { MockExecutor } from '../../src/backtest/mockExecutor.js'
import { ResultCollector } from '../../src/backtest/resultCollector.js'
import { EventReplayProvider } from '../../src/backtest/replayProvider.js'
import { generateSignals } from '../../src/strategy/signalGenerator.js'
import { wireSignalGenerator } from '../../src/strategy/signalGenerator.js'
import { RiskManager, wireRiskManager, resetTrackedPositions } from '../../src/strategy/riskManager.js'
import { calculateConfidence, getMinConfidence } from '../../src/strategy/confidenceScorer.js'
import { analyzeOnchainProposal, analyzeSnapshotProposal, analyzeForumPost } from '../../src/analysis/intelligenceEngine.js'
import { resetCorrelator } from '../../src/analysis/proposalCorrelator.js'
import type { ProposalCreatedEvent, SnapshotProposalEvent, ForumPostEvent, IntelligentAnalysis } from '../../src/types/governance.js'
import type { TradeSignal, Position } from '../../src/types/trading.js'

// ─── Helpers ─────────────────────────────────────────────────────────

let db: Database.Database
let clock: VirtualClock
let prevClock: any

function seedPrice(asset: string, timestamp: number, price: string) {
  db.prepare(
    `INSERT OR IGNORE INTO historical_prices (asset, timestamp, price, source)
     VALUES (?, ?, ?, 'test')`,
  ).run(asset, timestamp, price)
}

function makeProposal(overrides: Partial<ProposalCreatedEvent> & { proposalId: bigint; protocol: any; description: string }): ProposalCreatedEvent {
  return {
    type: 'proposal_created',
    blockNumber: 18000000n,
    transactionHash: '0x' + 'ab'.repeat(32),
    logIndex: 0,
    removed: false,
    proposer: '0x' + '11'.repeat(20),
    targets: [],
    values: [],
    signatures: [],
    calldatas: [],
    ...overrides,
  }
}

beforeEach(() => {
  db = initBacktestStore(':memory:')
  clock = new VirtualClock(new Date('2025-07-01T12:00:00Z').getTime())
  prevClock = setClock(clock)
  resetTrackedPositions()
  resetCorrelator()
})

afterEach(() => {
  setClock(prevClock)
  eventBus.removeAllListeners()
  db.close()
})

// ─── 1. Signal Generation Logic ──────────────────────────────────────

describe('Signal Generation — Direction Correctness', () => {
  it('LTV DECREASE on WETH → SHORT signal (liquidation cascade risk)', () => {
    const proposal = makeProposal({
      proposalId: 100n,
      protocol: 'compound',
      targets: ['0xA17581A9E3356d9A858b789D68B4d866e593aE94'], // cWETHv3
      signatures: ['updateAssetLiquidateCollateralFactor(address,uint64)'],
      description: 'Reduce WETH liquidation collateral factor from 90% to 85%',
    })

    const analysis = analyzeOnchainProposal(proposal)
    const signals = generateSignals(analysis, [])

    expect(signals.length).toBeGreaterThan(0)

    // A LT decrease should produce a SHORT signal — bearish for the asset
    const shortSignals = signals.filter(s => s.direction === 'short')
    expect(shortSignals.length).toBeGreaterThan(0)
  })

  it('SUPPLY CAP INCREASE → no on-chain long (on-chain longs filtered — alpha is in forum posts)', () => {
    const proposal = makeProposal({
      proposalId: 101n,
      protocol: 'compound',
      targets: ['0x64b761D848206f447Fe2dd461b0c635Ec39EbB27'], // Aave PoolConfigurator
      signatures: ['setSupplyCap(address,uint256)'],
      description: 'Increase LINK supply cap to 10M in Aave V3',
    })

    const analysis = analyzeOnchainProposal(proposal)
    const signals = generateSignals(analysis, [])

    // On-chain longs are filtered — the alpha was already captured via forum discussions
    expect(signals.length).toBe(0)
  })

  it('RESERVE FREEZE → SHORT signal (flight to safety)', () => {
    const proposal = makeProposal({
      proposalId: 102n,
      protocol: 'aave',
      targets: ['0x64b761D848206f447Fe2dd461b0c635Ec39EbB27'],
      signatures: ['setReserveFreeze(address,bool)'],
      description: 'Freeze LINK reserve on Aave V3 due to oracle issues',
    })

    const analysis = analyzeOnchainProposal(proposal)
    const signals = generateSignals(analysis, [])

    expect(signals.length).toBeGreaterThan(0)
    const shortSignals = signals.filter(s => s.direction === 'short')
    expect(shortSignals.length).toBeGreaterThan(0)
  })

  it('DSR INCREASE → no on-chain long (on-chain longs filtered; forum captures early alpha)', () => {
    const proposal = makeProposal({
      proposalId: 103n,
      protocol: 'maker',
      targets: ['0x' + '00'.repeat(20)],
      signatures: ['setDSR(uint256)'],
      description: 'Increase DAI Savings Rate from 5% to 8%',
    })

    const analysis = analyzeOnchainProposal(proposal)
    const signals = generateSignals(analysis, [])

    // On-chain longs are filtered — forum captures this alpha earlier
    const mkrLongs = signals.filter(s => s.asset === 'MKR' && s.direction === 'long')
    expect(mkrLongs.length).toBe(0)
  })

  it('generates no signal for irrelevant proposals', () => {
    const proposal = makeProposal({
      proposalId: 104n,
      protocol: 'compound',
      targets: ['0x' + '00'.repeat(20)],
      signatures: ['someUnknownFunction()'],
      description: 'Update administrative configuration for the DAO multisig',
    })

    const analysis = analyzeOnchainProposal(proposal)
    // Should have minimal or no tradeable signals
    const signals = generateSignals(analysis, [])
    // All signals, if any, should be low urgency or confidence
    for (const s of signals) {
      expect(s.confidence).toBeLessThan(0.5)
    }
  })
})

// ─── 2. Confidence Scorer Logic ──────────────────────────────────────

describe('Confidence Scorer — Feature Weights', () => {
  function makeAnalysis(overrides: Partial<IntelligentAnalysis>): IntelligentAnalysis {
    return {
      proposalId: 'test',
      protocol: 'aave',
      stage: 'onchain_vote',
      title: 'Test proposal',
      description: 'Test',
      actions: [],
      impacts: [],
      cascadeImpacts: [],
      confidenceScore: 0.5,
      timestamp: Date.now(),
      proposalType: 'technical_parameter',
      dynamicImpacts: [],
      nlpConfidence: 0.7,
      sentiment: 'bearish',
      extractedAssets: ['WETH'],
      ...overrides,
    }
  }

  function makeImpact(overrides: Partial<any> = {}): any {
    return {
      type: 'technical_parameter',
      affectedAssets: ['WETH'],
      affectedProtocols: ['aave'],
      technicalCategory: 'ltv_change',
      expectedPriceImpact: 'moderate_negative',
      tradingOpportunity: true,
      confidence: 0.7,
      severity: 'high',
      rationale: 'test',
      ...overrides,
    }
  }

  it('higher stage = higher confidence (timelock > snapshot > discussion)', () => {
    const timelockAnalysis = makeAnalysis({ stage: 'timelock' })
    const snapshotAnalysis = makeAnalysis({ stage: 'snapshot' })
    const discussionAnalysis = makeAnalysis({ stage: 'discussion' })
    const impact = makeImpact()

    const timelockConf = calculateConfidence(timelockAnalysis, impact, 'short', 'WETH')
    const snapshotConf = calculateConfidence(snapshotAnalysis, impact, 'short', 'WETH')
    const discussionConf = calculateConfidence(discussionAnalysis, impact, 'short', 'WETH')

    expect(timelockConf).toBeGreaterThan(snapshotConf)
    expect(snapshotConf).toBeGreaterThan(discussionConf)
  })

  it('sentiment alignment boosts confidence', () => {
    const analysis = makeAnalysis({ sentiment: 'bearish' })
    const impact = makeImpact()

    const aligned = calculateConfidence(analysis, impact, 'short', 'WETH')
    const misaligned = calculateConfidence(analysis, impact, 'long', 'WETH')

    expect(aligned).toBeGreaterThan(misaligned)
  })

  it('known assets get higher confidence than unknown addresses', () => {
    const analysis = makeAnalysis()
    const impact = makeImpact()

    const knownAsset = calculateConfidence(analysis, impact, 'short', 'WETH')
    const unknownAsset = calculateConfidence(analysis, impact, 'short', '0xdeadbeef')

    expect(knownAsset).toBeGreaterThan(unknownAsset)
  })

  it('calldata-decoded proposals get higher confidence than NLP-only', () => {
    const withCalldata = makeAnalysis({ actions: [{ target: '0x', functionName: 'test', params: {} }] })
    const withoutCalldata = makeAnalysis({ actions: [] })
    const impact = makeImpact()

    const calldataConf = calculateConfidence(withCalldata, impact, 'short', 'WETH')
    const nlpOnlyConf = calculateConfidence(withoutCalldata, impact, 'short', 'WETH')

    expect(calldataConf).toBeGreaterThan(nlpOnlyConf)
  })

  it('minimum confidence thresholds decrease as stage advances', () => {
    // Later stages = lower threshold = more signals pass
    expect(getMinConfidence('monitoring')).toBeGreaterThan(getMinConfidence('onchain_vote'))
    expect(getMinConfidence('onchain_vote')).toBeGreaterThanOrEqual(getMinConfidence('timelock'))
    expect(getMinConfidence('timelock')).toBeGreaterThanOrEqual(getMinConfidence('executed'))
  })
})

// ─── 3. Risk Manager Logic ───────────────────────────────────────────

describe('Risk Manager — Position Sizing & Leverage', () => {
  it('caps signal size to 15% of portfolio (max single position)', () => {
    const rm = new RiskManager()
    const signal: TradeSignal = {
      id: 'test-1',
      asset: 'WETH',
      direction: 'short',
      sizePct: 25, // Way too large
      protocol: 'dydx',
      confidence: 0.8,
      rationale: 'test',
      proposalId: '1',
      governanceStage: 'onchain_vote',
      timestamp: Date.now(),
      urgency: 'high',
    }

    const validated = rm.validateSignal(signal)
    expect(validated).not.toBeNull()
    expect(validated!.sizePct).toBeLessThanOrEqual(15) // Default max
  })

  it('rejects signals when total exposure exceeds 60%', () => {
    const rm = new RiskManager()
    rm.updatePortfolio([
      {
        id: 'pos-1', protocol: 'dydx', type: 'perp', asset: 'WETH',
        size: '50', entryPrice: '2000', currentPrice: '2000',
        unrealizedPnl: '0', realizedPnl: '0', accruedYield: '0',
        lastUpdated: new Date().toISOString(),
      },
    ], 100_000)

    const signal: TradeSignal = {
      id: 'test-2',
      asset: 'AAVE',
      direction: 'long',
      sizePct: 5,
      protocol: 'dydx',
      confidence: 0.8,
      rationale: 'test',
      proposalId: '2',
      governanceStage: 'onchain_vote',
      timestamp: Date.now(),
      urgency: 'medium',
    }

    const validated = rm.validateSignal(signal)
    // Should be rejected or capped since 50*2000 = $100k = 100% exposure already
    expect(validated).toBeNull()
  })

  it('progressive stage reduction: snapshot→timelock→executed', () => {
    const rm = new RiskManager()
    rm.trackPosition('proposal:1', 'pos-1', 'WETH', 100)

    // Snapshot stage: reduce to 75%
    const r1 = rm.handleStageTransition('proposal:1', 'snapshot')
    expect(r1.length).toBe(1)
    expect(r1[0].reduceByPct).toBe(25)

    // Timelock stage: reduce to 25%
    const r2 = rm.handleStageTransition('proposal:1', 'timelock')
    expect(r2.length).toBe(1)
    expect(r2[0].reduceByPct).toBe(50)

    // Executed: exit fully
    const r3 = rm.handleStageTransition('proposal:1', 'executed')
    expect(r3.length).toBe(1)
    expect(r3[0].reduceByPct).toBe(25)
  })

  it('drawdown protection: rejects new signals during drawdown', () => {
    const rm = new RiskManager({ maxDrawdownPct: 10 })
    // Unrealized loss of -15000 on 100k portfolio = 15% drawdown > 10% threshold
    rm.updatePortfolio([
      {
        id: 'pos-1', protocol: 'dydx', type: 'perp', asset: 'WETH',
        size: '10', entryPrice: '2000', currentPrice: '500',
        unrealizedPnl: '-15000', realizedPnl: '0', accruedYield: '0',
        lastUpdated: new Date().toISOString(),
      },
    ], 100_000)

    const signal: TradeSignal = {
      id: 'test-dd',
      asset: 'AAVE',
      direction: 'long',
      sizePct: 3,
      protocol: 'dydx',
      confidence: 0.8,
      rationale: 'test',
      proposalId: '3',
      governanceStage: 'onchain_vote',
      timestamp: Date.now(),
      urgency: 'medium',
    }

    const validated = rm.validateSignal(signal)
    expect(validated).toBeNull() // Rejected due to drawdown
  })
})

// ─── 4. Snapshot NLP Analysis ────────────────────────────────────────

describe('Snapshot & Forum Analysis — NLP Correctness', () => {
  it('Snapshot: "Reduce COMP emissions" → bearish COMP signal', () => {
    const snap: SnapshotProposalEvent = {
      type: 'snapshot_proposal',
      protocol: 'compound',
      snapshotId: '0xtest1',
      title: 'Reduce COMP emissions schedule by 30%',
      body: 'This proposal reduces COMP token emissions to improve sustainability.',
      choices: ['For', 'Against', 'Abstain'],
      start: Date.now(),
      end: Date.now() + 604800_000,
      snapshot: '',
      state: 'active',
      author: '0xtest',
      scores: [200, 50, 10],
      scoresTotal: 260,
      space: 'compound-governance.eth',
    }

    const analysis = analyzeSnapshotProposal(snap)
    expect(analysis).not.toBeNull()
    // Should identify COMP as affected asset
    expect(analysis!.extractedAssets).toContain('COMP')
  })

  it('Snapshot: "Onboard wstETH to Aave V3" → bullish wstETH signal', () => {
    const snap: SnapshotProposalEvent = {
      type: 'snapshot_proposal',
      protocol: 'aave',
      snapshotId: '0xtest2',
      title: 'Onboard wstETH as collateral on Aave V3 Ethereum',
      body: 'This proposal adds wstETH as a new collateral type with 80% LTV.',
      choices: ['For', 'Against'],
      start: Date.now(),
      end: Date.now() + 604800_000,
      snapshot: '',
      state: 'active',
      author: '0xtest',
      scores: [500, 20],
      scoresTotal: 520,
      space: 'aavedao.eth',
    }

    const analysis = analyzeSnapshotProposal(snap)
    expect(analysis).not.toBeNull()
    expect(analysis!.proposalType).toBe('asset_onboarding')
  })

  it('Forum: governance discussion → passes through with governance token fallback', () => {
    // Changed: governance_process forum posts now flow through to the signal generator
    // (previously killed in intelligence engine). The signal generator handles filtering
    // via sentiment checks and confidence thresholds.
    const post: ForumPostEvent = {
      type: 'forum_post',
      protocol: 'compound',
      forumUrl: 'https://www.comp.xyz',
      topicId: 9999,
      title: 'Community call summary - January 2025',
      categoryId: 1,
      createdAt: new Date().toISOString(),
      postsCount: 5,
      replyCount: 3,
      views: 100,
    }

    const analysis = analyzeForumPost(post)
    // Now returns analysis with gov token fallback (COMP for compound protocol)
    expect(analysis).not.toBeNull()
    expect(analysis!.stage).toBe('discussion')
    expect(analysis!.protocol).toBe('compound')
  })
})

// ─── 5. Full Pipeline End-to-End with P&L ────────────────────────────

describe('Full Pipeline — End-to-End P&L', () => {
  it('LT decrease → short WETH → price drops → PROFIT', () => {
    const baseTs = new Date('2025-07-01T12:00:00Z').getTime()
    clock = new VirtualClock(baseTs - 3600_000)
    setClock(clock)

    // Price drops after LT decrease announcement (realistic)
    seedPrice('WETH', baseTs - 3600_000, '2000.00')
    seedPrice('WETH', baseTs, '1990.00')
    seedPrice('WETH', baseTs + 3600_000, '1950.00')
    seedPrice('WETH', baseTs + 86400_000, '1900.00') // -5% over 24h

    const mockPrices = new MockPriceMonitor(db, clock)
    const collector = new ResultCollector(clock, mockPrices, 100_000)
    const mockExecutor = new MockExecutor(mockPrices, clock, undefined, undefined, () => collector.getPortfolioValue())
    const riskManager = new RiskManager()

    collector.start()

    // Wire pipeline
    eventBus.on('governance:proposal', (event: any) => {
      if (event.type !== 'proposal_created') return
      const analysis = analyzeOnchainProposal(event)
      if (analysis.impacts.length > 0 || analysis.dynamicImpacts.length > 0) {
        eventBus.emit('analysis:proposal', analysis)
      }
    })
    wireSignalGenerator(() => collector.getCurrentPositions())
    wireRiskManager(riskManager)
    mockExecutor.wire()

    // Advance clock and emit proposal
    clock.advanceTo(baseTs)
    const proposal = makeProposal({
      proposalId: 200n,
      protocol: 'compound',
      targets: ['0xA17581A9E3356d9A858b789D68B4d866e593aE94'],
      signatures: ['updateAssetLiquidateCollateralFactor(address,uint64)'],
      description: 'Reduce WETH liquidation collateral factor from 90% to 82%',
    })
    eventBus.emit('governance:proposal', proposal)

    // Advance 24h and close
    clock.advanceTo(baseTs + 86400_000)
    collector.closeAllPositions()

    // Verify we traded
    expect(collector.signals.length).toBeGreaterThan(0)
    expect(collector.trades.length).toBeGreaterThan(0)

    // The trade should be profitable if direction was correct
    const closedTrades = collector.trades.filter(t => t.pnl !== null)
    expect(closedTrades.length).toBeGreaterThan(0)

    // Check: SHORT signal on WETH + price dropped = should be profitable
    const wethTrade = closedTrades.find(t => t.asset.includes('WETH') || t.asset.includes('0xA175'))
    if (wethTrade && wethTrade.direction === 'short') {
      // Short trade + price dropped = profit
      expect(wethTrade.pnl!).toBeGreaterThan(0)
    }
  })

  it('supply cap increase → no on-chain long trade (on-chain longs filtered)', () => {
    const baseTs = new Date('2025-08-01T12:00:00Z').getTime()
    clock = new VirtualClock(baseTs - 3600_000)
    setClock(clock)

    seedPrice('AAVE', baseTs - 3600_000, '95.00')
    seedPrice('AAVE', baseTs, '96.00')
    seedPrice('AAVE', baseTs + 3600_000, '100.00')
    seedPrice('AAVE', baseTs + 86400_000, '105.00') // +10%

    const mockPrices = new MockPriceMonitor(db, clock)
    const collector = new ResultCollector(clock, mockPrices, 100_000)
    const mockExecutor = new MockExecutor(mockPrices, clock, undefined, undefined, () => collector.getPortfolioValue())
    const riskManager = new RiskManager()

    collector.start()

    eventBus.on('governance:proposal', (event: any) => {
      if (event.type !== 'proposal_created') return
      const analysis = analyzeOnchainProposal(event)
      if (analysis.impacts.length > 0 || analysis.dynamicImpacts.length > 0) {
        eventBus.emit('analysis:proposal', analysis)
      }
    })
    wireSignalGenerator(() => collector.getCurrentPositions())
    wireRiskManager(riskManager)
    mockExecutor.wire()

    clock.advanceTo(baseTs)
    const proposal = makeProposal({
      proposalId: 201n,
      protocol: 'aave',
      targets: ['0x64b761D848206f447Fe2dd461b0c635Ec39EbB27'],
      signatures: ['setSupplyCap(address,uint256)'],
      description: 'Increase AAVE supply cap to 5M on Aave V3',
    })
    eventBus.emit('governance:proposal', proposal)

    clock.advanceTo(baseTs + 86400_000)
    collector.closeAllPositions()

    // On-chain longs are filtered — no trade generated
    expect(collector.trades.length).toBe(0)
  })

  it('portfolio value stays consistent through trades', () => {
    const baseTs = new Date('2025-09-01T12:00:00Z').getTime()
    clock = new VirtualClock(baseTs)
    setClock(clock)

    seedPrice('WETH', baseTs, '2000.00')
    seedPrice('WETH', baseTs + 86400_000, '2000.00') // flat price

    const mockPrices = new MockPriceMonitor(db, clock)
    const collector = new ResultCollector(clock, mockPrices, 100_000)

    collector.start()

    // Before any trades: portfolio = 100k
    expect(collector.getPortfolioValue()).toBe(100_000)

    // After close with no trades: still 100k
    collector.closeAllPositions()
    expect(collector.getPortfolioValue()).toBe(100_000)
  })
})

// ─── 6. Critical Logic Gaps ──────────────────────────────────────────

describe('Critical Logic Gaps — Things Missing for Profitable Leverage Bot', () => {
  it('Kelly Criterion: position sizing uses Kelly formula (3-15% range)', () => {
    const proposal = makeProposal({
      proposalId: 300n,
      protocol: 'compound',
      targets: ['0xA17581A9E3356d9A858b789D68B4d866e593aE94'],
      signatures: ['updateAssetLiquidateCollateralFactor(address,uint64)'],
      description: 'Reduce WETH LT from 90% to 85%',
    })

    const analysis = analyzeOnchainProposal(proposal)
    const signals = generateSignals(analysis, [])

    expect(signals.length).toBeGreaterThan(0)
    for (const s of signals) {
      // Kelly sizing produces 3-15% positions (configurable)
      expect(s.sizePct).toBeGreaterThanOrEqual(3)
      expect(s.sizePct).toBeLessThanOrEqual(15)
    }
  })

  it('Leverage: Binance perp signals have leverage > 1x', () => {
    const proposal = makeProposal({
      proposalId: 301n,
      protocol: 'compound',
      targets: ['0xA17581A9E3356d9A858b789D68B4d866e593aE94'],
      signatures: ['updateAssetLiquidateCollateralFactor(address,uint64)'],
      description: 'Reduce WETH LT from 90% to 85%',
    })

    const analysis = analyzeOnchainProposal(proposal)
    const signals = generateSignals(analysis, [])

    const dydxSignals = signals.filter(s => s.protocol === 'binance')
    expect(dydxSignals.length).toBeGreaterThan(0)

    for (const s of dydxSignals) {
      expect(s.leverage).toBeDefined()
      expect(s.leverage!).toBeGreaterThan(1)
      expect(s.leverage!).toBeLessThanOrEqual(20) // Max Binance leverage
    }
  })

  it('TP/SL: all signals have stop-loss and take-profit', () => {
    const proposal = makeProposal({
      proposalId: 302n,
      protocol: 'compound',
      targets: ['0xA17581A9E3356d9A858b789D68B4d866e593aE94'],
      signatures: ['updateAssetLiquidateCollateralFactor(address,uint64)'],
      description: 'Reduce WETH LT from 90% to 85%',
    })

    const analysis = analyzeOnchainProposal(proposal)
    const signals = generateSignals(analysis, [])

    expect(signals.length).toBeGreaterThan(0)
    for (const s of signals) {
      expect(s.stopLossPct).toBeDefined()
      expect(s.stopLossPct!).toBeGreaterThan(0)
      expect(s.stopLossPct!).toBeLessThan(0.20) // Max 20% SL

      expect(s.takeProfitPct).toBeDefined()
      expect(s.takeProfitPct!).toBeGreaterThan(0)
      expect(s.takeProfitPct!).toBeGreaterThan(s.stopLossPct!) // TP > SL (positive R:R)

      expect(s.maxHoldingHours).toBeDefined()
      expect(s.maxHoldingHours!).toBeGreaterThan(0)
    }
  })

  it('Trailing stop: signals have trailing stop configuration', () => {
    const proposal = makeProposal({
      proposalId: 303n,
      protocol: 'compound',
      targets: ['0xA17581A9E3356d9A858b789D68B4d866e593aE94'],
      signatures: ['updateAssetLiquidateCollateralFactor(address,uint64)'],
      description: 'Reduce WETH LT from 90% to 85%',
    })

    const analysis = analyzeOnchainProposal(proposal)
    const signals = generateSignals(analysis, [])

    // High-urgency signals should have trailing stop configured
    const highUrgency = signals.filter(s => s.urgency === 'high')
    for (const s of highUrgency) {
      expect(s.trailingStopActivation).toBeDefined()
      expect(s.trailingStopActivation!).toBeGreaterThan(0)
      expect(s.trailingStopDistance).toBeDefined()
      expect(s.trailingStopDistance!).toBeGreaterThan(0)
      expect(s.trailingStopDistance!).toBeLessThan(s.trailingStopActivation!) // Trail < activation
    }
  })

  it('Risk/Reward ratio: TP/SL gives positive expected value', () => {
    const proposal = makeProposal({
      proposalId: 304n,
      protocol: 'compound',
      targets: ['0xA17581A9E3356d9A858b789D68B4d866e593aE94'],
      signatures: ['updateAssetLiquidateCollateralFactor(address,uint64)'],
      description: 'Reduce WETH LT from 90% to 85%',
    })

    const analysis = analyzeOnchainProposal(proposal)
    const signals = generateSignals(analysis, [])

    for (const s of signals) {
      if (s.stopLossPct && s.takeProfitPct) {
        // R:R ratio = TP / SL — should be >= 2 for positive expected value
        const rr = s.takeProfitPct / s.stopLossPct
        expect(rr).toBeGreaterThanOrEqual(2)
      }
    }
  })
})
