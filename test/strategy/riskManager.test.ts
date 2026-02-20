/**
 * Tests for risk manager — signal validation and governance-stage stop-loss.
 */
import { describe, it, expect } from 'vitest'
import { RiskManager } from '../../src/strategy/riskManager.js'
import type { TradeSignal, Position } from '../../src/types/trading.js'

function makeSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    id: 'test-signal',
    asset: 'AAVE',
    direction: 'long',
    sizePct: 5,
    protocol: 'binance',
    confidence: 0.7,
    rationale: 'Test signal',
    proposalId: 'compound:42',
    governanceStage: 'onchain_vote',
    timestamp: Date.now(),
    urgency: 'medium',
    ...overrides,
  }
}

describe('RiskManager', () => {
  describe('validateSignal', () => {
    it('passes valid signal', () => {
      const rm = new RiskManager()
      const signal = makeSignal({ confidence: 0.7, sizePct: 5 })
      const result = rm.validateSignal(signal)
      expect(result).not.toBeNull()
      expect(result!.sizePct).toBe(5)
    })

    it('rejects signal below minimum confidence', () => {
      const rm = new RiskManager({ minConfidence: 0.5 })
      const signal = makeSignal({ confidence: 0.2 })
      const result = rm.validateSignal(signal)
      expect(result).toBeNull()
    })

    it('caps signal size to max single position', () => {
      const rm = new RiskManager({ maxSinglePositionPct: 10 })
      const signal = makeSignal({ sizePct: 25 })
      const result = rm.validateSignal(signal)
      expect(result).not.toBeNull()
      expect(result!.sizePct).toBe(10)
    })

    it('rejects signal when proposal is already executed', () => {
      const rm = new RiskManager()
      const signal = makeSignal({ governanceStage: 'executed' })
      const result = rm.validateSignal(signal)
      expect(result).toBeNull()
    })
  })

  describe('handleStageTransition', () => {
    it('returns reductions when stage advances', () => {
      const rm = new RiskManager()
      rm.trackPosition('compound:42', 'dydx:AAVE', 'AAVE', 100)

      // Move from monitoring to snapshot → should reduce to 75%
      const actions = rm.handleStageTransition('compound:42', 'snapshot')
      expect(actions).toHaveLength(1)
      expect(actions[0].positionId).toBe('dydx:AAVE')
      expect(actions[0].reduceByPct).toBe(25) // 100 → 75
    })

    it('reduces further on subsequent transitions', () => {
      const rm = new RiskManager()
      rm.trackPosition('aave:10', 'dydx:UNI', 'UNI', 100)

      rm.handleStageTransition('aave:10', 'snapshot') // 100 → 75
      const actions2 = rm.handleStageTransition('aave:10', 'onchain_vote') // 75 → 50
      expect(actions2).toHaveLength(1)
      expect(actions2[0].reduceByPct).toBe(25) // 75 → 50
    })

    it('fully exits on executed stage', () => {
      const rm = new RiskManager()
      rm.trackPosition('maker:5', 'dydx:MKR', 'MKR', 100)

      const actions = rm.handleStageTransition('maker:5', 'executed')
      expect(actions).toHaveLength(1)
      expect(actions[0].reduceByPct).toBe(100) // exit fully
    })

    it('returns empty for untracked proposals', () => {
      const rm = new RiskManager()
      const actions = rm.handleStageTransition('unknown:99', 'timelock')
      expect(actions).toHaveLength(0)
    })
  })

  describe('checkHealthFactors', () => {
    it('alerts on HF below alert threshold', () => {
      const rm = new RiskManager({ aaveHfAlertThreshold: 1.5, aaveHfReduceThreshold: 1.2 })

      const positions: Position[] = [
        {
          id: 'aave:collateral',
          protocol: 'aave',
          type: 'lending_supply',
          asset: 'WETH',
          size: '10',
          entryPrice: '1',
          currentPrice: '1',
          unrealizedPnl: '0',
          realizedPnl: '0',
          accruedYield: '0',
          healthFactor: 1.3, // Below alert, above reduce
          lastUpdated: new Date().toISOString(),
        },
      ]

      rm.updatePortfolio(positions, 10000)
      const alerts = rm.checkHealthFactors()
      expect(alerts).toHaveLength(1)
      expect(alerts[0].action).toBe('alert')
    })

    it('signals reduce on HF below reduce threshold', () => {
      const rm = new RiskManager({ aaveHfAlertThreshold: 1.5, aaveHfReduceThreshold: 1.2 })

      const positions: Position[] = [
        {
          id: 'aave:collateral',
          protocol: 'aave',
          type: 'lending_supply',
          asset: 'WETH',
          size: '10',
          entryPrice: '1',
          currentPrice: '1',
          unrealizedPnl: '0',
          realizedPnl: '0',
          accruedYield: '0',
          healthFactor: 1.1, // Below reduce threshold
          lastUpdated: new Date().toISOString(),
        },
      ]

      rm.updatePortfolio(positions, 10000)
      const alerts = rm.checkHealthFactors()
      expect(alerts).toHaveLength(1)
      expect(alerts[0].action).toBe('reduce')
    })

    it('returns nothing for healthy positions', () => {
      const rm = new RiskManager()
      const positions: Position[] = [
        {
          id: 'aave:collateral',
          protocol: 'aave',
          type: 'lending_supply',
          asset: 'WETH',
          size: '10',
          entryPrice: '1',
          currentPrice: '1',
          unrealizedPnl: '0',
          realizedPnl: '0',
          accruedYield: '0',
          healthFactor: 2.5, // Healthy
          lastUpdated: new Date().toISOString(),
        },
      ]

      rm.updatePortfolio(positions, 10000)
      const alerts = rm.checkHealthFactors()
      expect(alerts).toHaveLength(0)
    })

    it('ignores non-Aave positions', () => {
      const rm = new RiskManager()
      const positions: Position[] = [
        {
          id: 'dydx:AAVE',
          protocol: 'binance',
          type: 'perp',
          asset: 'AAVE',
          size: '10',
          entryPrice: '1',
          currentPrice: '1',
          unrealizedPnl: '0',
          realizedPnl: '0',
          accruedYield: '0',
          lastUpdated: new Date().toISOString(),
        },
      ]

      rm.updatePortfolio(positions, 10000)
      const alerts = rm.checkHealthFactors()
      expect(alerts).toHaveLength(0)
    })
  })
})
