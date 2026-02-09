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
    confidenceScore: 0.5,
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
    expect(shortSignal!.protocol).toBe('dydx')
    expect(shortSignal!.confidence).toBeGreaterThan(0)
  })

  it('generates long signal for supply cap increase', () => {
    const analysis = makeAnalysis({
      stage: 'onchain_vote',
      impacts: [
        {
          category: 'supply_cap_change',
          asset: 'WETH',
          currentValue: '50000',
          proposedValue: '100000',
          severity: 'medium',
        },
      ],
    })

    const signals = generateSignals(analysis, [])
    const longSignal = signals.find(s => s.direction === 'long')
    expect(longSignal).toBeDefined()
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
    // Should generate both a short (dydx) and a PT trade (pendle)
    expect(signals.length).toBeGreaterThanOrEqual(1)
    expect(signals.some(s => s.direction === 'short')).toBe(true)
  })

  it('scales confidence by governance stage', () => {
    const discussionAnalysis = makeAnalysis({
      stage: 'discussion',
      impacts: [{ category: 'borrow_cap_change', asset: 'WETH', severity: 'medium' }],
    })

    const timelockAnalysis = makeAnalysis({
      stage: 'timelock',
      impacts: [{ category: 'borrow_cap_change', asset: 'WETH', severity: 'medium' }],
    })

    const discussionSignals = generateSignals(discussionAnalysis, [])
    const timelockSignals = generateSignals(timelockAnalysis, [])

    // Timelock signals should have higher confidence
    if (discussionSignals.length > 0 && timelockSignals.length > 0) {
      expect(timelockSignals[0].confidence).toBeGreaterThan(discussionSignals[0].confidence)
    }
  })

  it('skips duplicate positions', () => {
    const analysis = makeAnalysis({
      stage: 'timelock',
      impacts: [{ category: 'supply_cap_change', asset: 'WETH', severity: 'medium' }],
    })

    const existingPosition: Position = {
      id: 'dydx:WETH',
      protocol: 'dydx',
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

    const signals = generateSignals(analysis, [existingPosition])
    // Should not generate a dydx signal for WETH since position exists
    const dydxWethSignal = signals.find(s => s.asset === 'WETH' && s.protocol === 'dydx')
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
