/**
 * Tests for signal generator — ProposalAnalysis → TradeSignal.
 */
import { describe, it, expect } from 'vitest'
import { generateSignals } from '../../src/strategy/signalGenerator.js'
import type { ProposalAnalysis } from '../../src/types/governance.js'
import type { Position } from '../../src/types/trading.js'

function makeAnalysis(overrides: Partial<ProposalAnalysis> = {}): ProposalAnalysis {
  return {
    proposalId: 'compound:42',
    protocol: 'compound',
    stage: 'onchain_vote',
    title: 'Test Proposal',
    description: 'Test',
    actions: [],
    impacts: [],
    cascadeImpacts: [],
    confidenceScore: 0.7,  // Higher default to pass stricter filters
    timestamp: Date.now(),
    ...overrides,
  }
}

describe('generateSignals', () => {
  it('generates short signal for LTV decrease', () => {
    const analysis = makeAnalysis({
      stage: 'timelock',
      impacts: [
        {
          category: 'ltv_change',
          asset: 'WETH',
          currentValue: '8250',
          proposedValue: '8000',
          severity: 'high',
        },
      ],
    })

    const signals = generateSignals(analysis, [])
    expect(signals.length).toBeGreaterThan(0)

    const shortSignal = signals.find(s => s.direction === 'short')
    expect(shortSignal).toBeDefined()
    expect(shortSignal!.protocol).toBe('binance')
    expect(shortSignal!.confidence).toBeGreaterThan(0)
  })

  it('on-chain: only allows shorts for freeze/LT/delisting, blocks generic caps', () => {
    // Cap changes at on-chain stage are filtered (not in bearish-categories set)
    const capAnalysis = makeAnalysis({
      stage: 'onchain_vote',
      confidenceScore: 0.8,  // High confidence for test
      impacts: [
        {
          category: 'supply_cap_change',
          asset: 'WETH',
          currentValue: '100000',
          proposedValue: '50000',
          severity: 'medium',
        },
      ],
    })
    const capSignals = generateSignals(capAnalysis, [])
    expect(capSignals.length).toBe(0) // Filtered: not in bearish-categories

    // LT decrease at timelock stage IS allowed (in bearish-categories)
    const ltAnalysis = makeAnalysis({
      stage: 'timelock',  // Lower threshold (0.30) for legacy path
      confidenceScore: 0.8,  // High confidence for test
      impacts: [
        {
          category: 'liquidation_threshold_change',
          asset: 'WETH',
          currentValue: '90',
          proposedValue: '85',
          severity: 'high',
        },
      ],
    })
    const ltSignals = generateSignals(ltAnalysis, [])
    const shortSignal = ltSignals.find(s => s.direction === 'short')
    expect(shortSignal).toBeDefined()
  })

  it('generates critical signals for reserve freeze', () => {
    const analysis = makeAnalysis({
      stage: 'timelock',
      impacts: [
        {
          category: 'reserve_freeze',
          asset: 'WBTC',
          severity: 'critical',
        },
      ],
    })

    const signals = generateSignals(analysis, [])
    // Should generate a short signal on dYdX
    expect(signals.length).toBeGreaterThanOrEqual(1)
    expect(signals.some(s => s.direction === 'short')).toBe(true)
  })

  it('stage gating: discussion may be filtered while timelock emits signal', () => {
    const discussionAnalysis = makeAnalysis({
      stage: 'discussion',
      confidenceScore: 0.9,
      impacts: [{ category: 'liquidation_threshold_change', asset: 'WETH', currentValue: '90', proposedValue: '85', severity: 'high' }],
    })

    const timelockAnalysis = makeAnalysis({
      stage: 'timelock',
      confidenceScore: 0.9,
      impacts: [{ category: 'liquidation_threshold_change', asset: 'WETH', currentValue: '90', proposedValue: '85', severity: 'high' }],
    })

    const discussionSignals = generateSignals(discussionAnalysis, [])
    const timelockSignals = generateSignals(timelockAnalysis, [])

    expect(timelockSignals.length).toBeGreaterThan(0)
    // Current strategy intentionally filters this impact at discussion stage.
    expect(discussionSignals.length).toBe(0)
  })

  it('skips duplicate positions', () => {
    const analysis = makeAnalysis({
      stage: 'timelock',
      confidenceScore: 0.9,
      impacts: [{ category: 'liquidation_threshold_change', asset: 'WETH', currentValue: '90', proposedValue: '85', severity: 'high' }],
    })

    const existingPosition: Position = {
      id: 'dydx:WETH',
      protocol: 'binance',
      type: 'perp',
      asset: 'WETH',
      size: '10',
      entryPrice: '2000',
      currentPrice: '2100',
      unrealizedPnl: '100',
      realizedPnl: '0',
      accruedYield: '0',
      lastUpdated: new Date().toISOString(),
    }

    const baselineSignals = generateSignals(analysis, [])
    expect(baselineSignals.some(s => s.asset === 'WETH' && s.protocol === 'binance')).toBe(true)

    const signals = generateSignals(analysis, [existingPosition])
    // Should not generate a binance signal for WETH since position exists
    const dydxWethSignal = signals.find(s => s.asset === 'WETH' && s.protocol === 'binance')
    expect(dydxWethSignal).toBeUndefined()
  })

  it('returns empty array for unclassified impacts', () => {
    const analysis = makeAnalysis({
      stage: 'onchain_vote',
      impacts: [],
    })

    const signals = generateSignals(analysis, [])
    expect(signals).toHaveLength(0)
  })
})
