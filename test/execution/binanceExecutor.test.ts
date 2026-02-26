/**
 * Tests for BinanceExecutor — trailing stop, max-holding-time metadata, order params.
 *
 * Mocks the Binance client to verify:
 *   1. TRAILING_STOP_MARKET order is placed with correct activationPrice + callbackRate
 *   2. callbackRate is clamped to Binance's 5% maximum
 *   3. Static STOP_MARKET is still placed (hard floor protection)
 *   4. TAKE_PROFIT_MARKET is still placed
 *   5. Dry-run returns symbol + maxHoldingHours in metadata
 *   6. Live execution returns symbol + maxHoldingHours in metadata
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Mock Binance client before importing executor ───────────────────
const placedOrders: Array<Record<string, string | number | boolean>> = []

// ─── Mock config ─────────────────────────────────────────────────────
vi.mock('../../src/config/index.js', () => ({
  config: {
    dryRun: false, // Live mode so placeOrder is called
    binanceApiKey: 'test-key',
    binanceApiSecret: 'test-secret',
    binanceTestnet: false,
    initialPortfolioUsd: 100000,
    logLevel: 'error',
  },
}))

vi.mock('../../src/clients/binance.js', async (importOriginal) => {
  const original = await importOriginal()
  return {
    ...original,
    getMarkPrice: vi.fn().mockResolvedValue('100.00'),
    getExchangeInfo: vi.fn().mockResolvedValue(new Map([
      ['AAVEUSDT', { tickSize: '0.01', stepSize: '0.01', minNotional: '5' }],
    ])),
    getAccountInfo: vi.fn().mockResolvedValue({ totalMarginBalance: '100000', positions: [] }),
    setLeverage: vi.fn().mockResolvedValue(undefined),
    setMarginType: vi.fn().mockResolvedValue(undefined),
    placeOrder: vi.fn().mockImplementation(async (params: Record<string, string | number | boolean>) => {
      placedOrders.push({ ...params })
      return { orderId: 12345, symbol: params.symbol, status: 'NEW', avgPrice: '100.00', executedQty: String(params.quantity) }
    }),
    placeTrailingStopAlgo: vi.fn().mockImplementation(async (params: Record<string, string | number | boolean>) => {
      // Store with type='TRAILING_STOP_MARKET' so existing assertions can find it
      placedOrders.push({ type: 'TRAILING_STOP_MARKET', ...params })
      return { algoId: 99999, symbol: params.symbol, status: 'NEW' }
    }),
    placeConditionalAlgo: vi.fn().mockImplementation(async (params: Record<string, string | number | boolean>) => {
      placedOrders.push({ ...params })
      return { algoId: 88888, symbol: params.symbol, status: 'NEW' }
    }),
    cancelAllOpenOrders: vi.fn().mockResolvedValue(undefined),
    cancelAlgoOrdersForSymbol: vi.fn().mockResolvedValue(undefined),
    roundStep: (_v: number, _step: string) => '1.00',
    roundTick: (v: number, _tick: string) => v.toFixed(2),
    ensureOneWayMode: vi.fn().mockResolvedValue(undefined),
  }
})

import { executeBinanceSignal, cancelPositionOrders } from '../../src/execution/binanceExecutor.js'
import type { TradeSignal } from '../../src/types/trading.js'

// ─── Helpers ─────────────────────────────────────────────────────────

function makeShortSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    id: 'test-sig-1',
    asset: 'AAVE',
    direction: 'short',
    sizePct: 12,
    leverage: 5,
    protocol: 'binance',
    confidence: 0.65,
    rationale: 'Test short signal',
    proposalId: 'aave:100',
    governanceStage: 'snapshot',
    timestamp: Date.now(),
    urgency: 'medium',
    stopLossPct: 0.12,
    takeProfitPct: 0.36,
    trailingStopActivation: 0.15,
    trailingStopDistance: 0.07,
    maxHoldingHours: 576,
    ...overrides,
  }
}

function makeLongSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    ...makeShortSignal(),
    id: 'test-sig-2',
    direction: 'long',
    stopLossPct: 0.08,
    takeProfitPct: 0.20,
    trailingStopActivation: 0.10,
    trailingStopDistance: 0.04,
    maxHoldingHours: 672,
    ...overrides,
  }
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('BinanceExecutor — Trailing Stop & Order Parity', () => {
  beforeEach(() => {
    placedOrders.length = 0
  })

  describe('Short signal — 3 protective orders placed', () => {
    it('places STOP_MARKET, TRAILING_STOP_MARKET, and TAKE_PROFIT_MARKET', async () => {
      const signal = makeShortSignal()
      const result = await executeBinanceSignal(signal)

      expect(result.success).toBe(true)

      const types = placedOrders.map((o) => o.type)
      expect(types).toContain('MARKET')
      expect(types).toContain('STOP_MARKET')
      expect(types).toContain('TRAILING_STOP_MARKET')
      expect(types).toContain('TAKE_PROFIT_MARKET')
    })

    it('trailing stop side is BUY (to close short)', async () => {
      await executeBinanceSignal(makeShortSignal())
      const trailOrder = placedOrders.find((o) => o.type === 'TRAILING_STOP_MARKET')
      expect(trailOrder?.side).toBe('BUY')
      expect(trailOrder?.reduceOnly).toBe(true)
    })

    it('trailing stop activationPrice = entry × (1 − activation)', async () => {
      // entryPrice = 100.00, activation = 0.15 → activationPrice = 85.00
      await executeBinanceSignal(makeShortSignal())
      const trailOrder = placedOrders.find((o) => o.type === 'TRAILING_STOP_MARKET')
      expect(parseFloat(String(trailOrder?.activationPrice))).toBeCloseTo(85.0, 1)
    })

    it('callbackRate clamped to 5% (Binance max) when trailingStopDistance=0.07', async () => {
      await executeBinanceSignal(makeShortSignal({ trailingStopDistance: 0.07 }))
      const trailOrder = placedOrders.find((o) => o.type === 'TRAILING_STOP_MARKET')
      expect(trailOrder?.callbackRate).toBe(5.0)
    })

    it('callbackRate = 4.0 when trailingStopDistance=0.04 (conservative — within limit)', async () => {
      await executeBinanceSignal(makeShortSignal({ trailingStopDistance: 0.04, trailingStopActivation: 0.10 }))
      const trailOrder = placedOrders.find((o) => o.type === 'TRAILING_STOP_MARKET')
      expect(trailOrder?.callbackRate).toBe(4.0)
    })

    it('STOP_MARKET triggerPrice = entry × (1 + stopLossPct) for short', async () => {
      // entry=100, stopLossPct=0.12 → triggerPrice=112.00
      await executeBinanceSignal(makeShortSignal())
      const slOrder = placedOrders.find((o) => o.type === 'STOP_MARKET')
      expect(parseFloat(String(slOrder?.triggerPrice))).toBeCloseTo(112.0, 1)
    })

    it('TAKE_PROFIT_MARKET triggerPrice = entry × (1 − takeProfitPct) for short', async () => {
      // entry=100, takeProfitPct=0.36 → triggerPrice=64.00
      await executeBinanceSignal(makeShortSignal())
      const tpOrder = placedOrders.find((o) => o.type === 'TAKE_PROFIT_MARKET')
      expect(parseFloat(String(tpOrder?.triggerPrice))).toBeCloseTo(64.0, 1)
    })
  })

  describe('Long signal — trailing stop activationPrice above entry', () => {
    it('trailing stop activationPrice = entry × (1 + activation) for long', async () => {
      // entry=100, activation=0.10 → activationPrice=110.00
      await executeBinanceSignal(makeLongSignal())
      const trailOrder = placedOrders.find((o) => o.type === 'TRAILING_STOP_MARKET')
      expect(parseFloat(String(trailOrder?.activationPrice))).toBeCloseTo(110.0, 1)
    })

    it('trailing stop side is SELL (to close long)', async () => {
      await executeBinanceSignal(makeLongSignal())
      const trailOrder = placedOrders.find((o) => o.type === 'TRAILING_STOP_MARKET')
      expect(trailOrder?.side).toBe('SELL')
    })
  })

  describe('No trailing stop when params missing', () => {
    it('does not place TRAILING_STOP_MARKET when trailingStopActivation is absent', async () => {
      const signal = makeShortSignal({ trailingStopActivation: undefined, trailingStopDistance: undefined })
      await executeBinanceSignal(signal)
      const trailOrder = placedOrders.find((o) => o.type === 'TRAILING_STOP_MARKET')
      expect(trailOrder).toBeUndefined()
    })
  })

  describe('Execution result metadata', () => {
    it('includes symbol and maxHoldingHours in live result', async () => {
      const signal = makeShortSignal()
      const result = await executeBinanceSignal(signal)
      expect(result.metadata?.symbol).toBe('AAVEUSDT')
      expect(result.metadata?.maxHoldingHours).toBe(576)
    })
  })

  describe('cancelPositionOrders', () => {
    it('delegates to binanceClient.cancelAllOpenOrders', async () => {
      const { cancelAllOpenOrders } = await import('../../src/clients/binance.js')
      await cancelPositionOrders('AAVEUSDT')
      expect(cancelAllOpenOrders).toHaveBeenCalledWith('AAVEUSDT')
    })
  })
})

describe('BinanceExecutor — Dry Run mode', () => {
  beforeEach(async () => {
    placedOrders.length = 0
    // Override config to dryRun=true
    const configMod = await import('../../src/config/index.js')
    ;(configMod.config as Record<string, unknown>).dryRun = true
  })

  afterEach(async () => {
    const configMod = await import('../../src/config/index.js')
    ;(configMod.config as Record<string, unknown>).dryRun = false
  })

  it('dry run returns success without placing real orders', async () => {
    const signal = makeShortSignal()
    const result = await executeBinanceSignal(signal)
    expect(result.success).toBe(true)
    expect(result.orderId).toMatch(/^dry-/)
    // Only the entry order check (no placeOrder calls in dry run)
    expect(placedOrders.length).toBe(0)
  })

  it('dry run metadata includes symbol and maxHoldingHours', async () => {
    const signal = makeShortSignal()
    const result = await executeBinanceSignal(signal)
    expect(result.metadata?.symbol).toBe('AAVEUSDT')
    expect(result.metadata?.maxHoldingHours).toBe(576)
    expect(result.metadata?.dryRun).toBe(true)
  })
})
