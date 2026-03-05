import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { VirtualClock } from '../../src/backtest/clock.js'
import { MockPriceMonitor } from '../../src/backtest/mockPrice.js'
import { MockExecutor } from '../../src/backtest/mockExecutor.js'
import { TOKENS } from '../../src/config/addresses.js'
import type { TradeSignal } from '../../src/types/trading.js'

function setup() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE historical_prices (
      asset TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      price TEXT NOT NULL
    );
  `)

  const now = Date.UTC(2026, 0, 1)
  db.prepare('INSERT INTO historical_prices (asset, timestamp, price) VALUES (?, ?, ?)').run('ARB', now, '1')

  const clock = new VirtualClock(now)
  const priceMonitor = new MockPriceMonitor(db, clock)
  const executor = new MockExecutor(priceMonitor, clock, undefined, undefined, () => 100_000)

  return { db, executor }
}

function baseSignal(asset: string): TradeSignal {
  return {
    id: `sig-${asset}`,
    asset,
    direction: 'short',
    sizePct: 50,
    protocol: 'binance',
    confidence: 0.8,
    rationale: 'test',
    proposalId: 'p1',
    governanceStage: 'snapshot',
    timestamp: Date.UTC(2026, 0, 1),
    urgency: 'medium',
    leverage: 4,
  }
}

describe('MockExecutor slippage symbol resolution', () => {
  test('uses resolved symbol liquidity tier when signal asset is an address', () => {
    const { db, executor } = setup()

    const symbolResult = executor.executeSignal(baseSignal('ARB'))
    const addressResult = executor.executeSignal(baseSignal(TOKENS.ARB))

    expect(symbolResult.success).toBe(true)
    expect(addressResult.success).toBe(true)

    expect(addressResult.executedPrice).toBe(symbolResult.executedPrice)
    expect(addressResult.metadata?.slippagePct).toBe(symbolResult.metadata?.slippagePct)

    db.close()
  })
})
