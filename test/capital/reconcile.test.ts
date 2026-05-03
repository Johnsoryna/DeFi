/**
 * Tests for position reconciliation (reconcilePositions).
 *
 * Scenarios:
 *   1. Ghost BTC trend position → cleared
 *   2. Live BTC trend position → kept
 *   3. Ghost bb_bounce position → cleared
 *   4. Live bb_bounce position → kept
 *   5. Ghost momentum position → cleared
 *   6. Live momentum position → kept
 *   7. Multiple ghosts across layers → all cleared, one alert
 *   8. Binance API failure → fail-open, no DB changes
 *   9. Unknown Binance position (manual trade) → warn, no DB changes
 *  10. Tables not yet created (first run) → no crash
 *  11. No positions anywhere → no action, no alert
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

// ─── In-memory DB shared across the test file ────────────────────────────────
// A single DB instance is created once; tables are truncated in beforeEach.
const memDb = new Database(':memory:')
memDb.exec(`
  CREATE TABLE IF NOT EXISTS btc_trend_position (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    direction    TEXT NOT NULL,
    entry_price  REAL NOT NULL DEFAULT 0,
    entry_ts     INTEGER NOT NULL DEFAULT 0,
    quantity     TEXT NOT NULL,
    notional     REAL NOT NULL DEFAULT 0,
    month        TEXT NOT NULL DEFAULT '',
    opened_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS bb_positions (
    symbol       TEXT PRIMARY KEY,
    direction    TEXT NOT NULL CHECK(direction IN ('long','short')),
    entry_price  REAL NOT NULL DEFAULT 0,
    entry_ts     INTEGER NOT NULL DEFAULT 0,
    quantity     TEXT NOT NULL,
    sl_price     REAL NOT NULL DEFAULT 0,
    tp_price     REAL NOT NULL DEFAULT 0,
    notional     REAL NOT NULL DEFAULT 0,
    atr_at_entry REAL NOT NULL DEFAULT 0,
    opened_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS mom_positions (
    symbol       TEXT PRIMARY KEY,
    entry_price  REAL NOT NULL DEFAULT 0,
    entry_ts     INTEGER NOT NULL DEFAULT 0,
    quantity     TEXT NOT NULL,
    notional     REAL NOT NULL DEFAULT 0,
    month        TEXT NOT NULL DEFAULT '',
    opened_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)

// ─── Module mocks (hoisted) ──────────────────────────────────────────────────
vi.mock('../../src/lib/store.js', () => ({ getDb: () => memDb }))
vi.mock('../../src/lib/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), fatal: vi.fn(),
  }),
}))
// alertService is injected — no module mock needed

// Import AFTER mocks are registered
import { reconcilePositions } from '../../src/capital/reconcile.js'
import type { BinancePosition } from '../../src/types/protocol.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeBinancePosition(symbol: string, positionAmt: string): BinancePosition {
  return {
    symbol, positionAmt,
    positionSide: 'BOTH',
    entryPrice: '100',
    markPrice: '100',
    unrealizedProfit: '0',
    leverage: '1',
    marginType: 'cross',
    liquidationPrice: '0',
  }
}

function insertBtcTrend(direction: 'long' | 'short', qty = '0.002'): void {
  memDb.prepare(`
    INSERT OR REPLACE INTO btc_trend_position (id, direction, quantity)
    VALUES (1, ?, ?)
  `).run(direction, qty)
}

function insertBbPosition(symbol: string, direction: 'long' | 'short', qty = '10'): void {
  memDb.prepare(`
    INSERT OR REPLACE INTO bb_positions (symbol, direction, quantity)
    VALUES (?, ?, ?)
  `).run(symbol, direction, qty)
}

function insertMomPosition(symbol: string, qty = '5'): void {
  memDb.prepare(`
    INSERT OR REPLACE INTO mom_positions (symbol, quantity)
    VALUES (?, ?)
  `).run(symbol, qty)
}

function getBtcTrendRow() {
  return memDb.prepare('SELECT * FROM btc_trend_position WHERE id = 1').get()
}

function getBbRow(symbol: string) {
  return memDb.prepare('SELECT * FROM bb_positions WHERE symbol = ?').get(symbol)
}

function getMomRow(symbol: string) {
  return memDb.prepare('SELECT * FROM mom_positions WHERE symbol = ?').get(symbol)
}

// Reset all tables before each test
beforeEach(() => {
  memDb.prepare('DELETE FROM btc_trend_position').run()
  memDb.prepare('DELETE FROM bb_positions').run()
  memDb.prepare('DELETE FROM mom_positions').run()
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('reconcilePositions', () => {

  it('1 — ghost BTC trend position is cleared when not on Binance', async () => {
    insertBtcTrend('short')
    const alert = vi.fn().mockResolvedValue(undefined)

    // Binance has NO open positions
    await reconcilePositions(async () => [], alert)

    expect(getBtcTrendRow()).toBeUndefined()
    expect(alert).toHaveBeenCalledOnce()
    expect(alert.mock.calls[0][2]).toContain('Ghost')
  })

  it('2 — live BTC trend position is kept when Binance confirms it', async () => {
    insertBtcTrend('short', '0.002')
    const alert = vi.fn().mockResolvedValue(undefined)

    // Binance has BTCUSDT open
    await reconcilePositions(async () => [makeBinancePosition('BTCUSDT', '-0.002')], alert)

    expect(getBtcTrendRow()).toBeDefined()
    expect(alert).not.toHaveBeenCalled()
  })

  it('3 — ghost bb_bounce position is cleared', async () => {
    insertBbPosition('SOLUSDT', 'long')
    const alert = vi.fn().mockResolvedValue(undefined)

    await reconcilePositions(async () => [], alert)

    expect(getBbRow('SOLUSDT')).toBeUndefined()
    expect(alert).toHaveBeenCalledOnce()
  })

  it('4 — live bb_bounce position is kept', async () => {
    insertBbPosition('SOLUSDT', 'long', '10')
    const alert = vi.fn().mockResolvedValue(undefined)

    await reconcilePositions(async () => [makeBinancePosition('SOLUSDT', '10')], alert)

    expect(getBbRow('SOLUSDT')).toBeDefined()
    expect(alert).not.toHaveBeenCalled()
  })

  it('5 — ghost momentum position is cleared', async () => {
    insertMomPosition('BNBUSDT')
    const alert = vi.fn().mockResolvedValue(undefined)

    await reconcilePositions(async () => [], alert)

    expect(getMomRow('BNBUSDT')).toBeUndefined()
    expect(alert).toHaveBeenCalledOnce()
  })

  it('6 — live momentum position is kept', async () => {
    insertMomPosition('BNBUSDT', '3')
    const alert = vi.fn().mockResolvedValue(undefined)

    await reconcilePositions(async () => [makeBinancePosition('BNBUSDT', '3')], alert)

    expect(getMomRow('BNBUSDT')).toBeDefined()
    expect(alert).not.toHaveBeenCalled()
  })

  it('7 — multiple ghosts across layers: all cleared, single alert with all entries', async () => {
    insertBtcTrend('short')
    insertBbPosition('AAVEUSDT', 'short')
    insertMomPosition('ETHUSDT')
    // Only AAVEUSDT is still open on Binance
    const alert = vi.fn().mockResolvedValue(undefined)

    await reconcilePositions(
      async () => [makeBinancePosition('AAVEUSDT', '-4.2')],
      alert,
    )

    expect(getBtcTrendRow()).toBeUndefined()        // ghost cleared
    expect(getBbRow('AAVEUSDT')).toBeDefined()      // live — kept
    expect(getMomRow('ETHUSDT')).toBeUndefined()    // ghost cleared

    expect(alert).toHaveBeenCalledOnce()
    const alertBody = alert.mock.calls[0][3] as string
    expect(alertBody).toContain('BTC Trend')
    expect(alertBody).toContain('Momentum ETHUSDT')
    expect(alertBody).not.toContain('BB AAVEUSDT')  // was not ghost
  })

  it('8 — Binance API failure: fail-open, DB unchanged, no alert', async () => {
    insertBtcTrend('short')
    const alert = vi.fn().mockResolvedValue(undefined)

    await reconcilePositions(
      async () => { throw new Error('API timeout') },
      alert,
    )

    // DB row must be preserved (we couldn't verify)
    expect(getBtcTrendRow()).toBeDefined()
    expect(alert).not.toHaveBeenCalled()
  })

  it('9 — unknown Binance position (manual trade): no DB changes, no alert', async () => {
    // DB is empty (no layer positions), but Binance has DOGEUSDT open
    const alert = vi.fn().mockResolvedValue(undefined)

    await reconcilePositions(
      async () => [makeBinancePosition('DOGEUSDT', '1000')],
      alert,
    )

    // No DB changes, no alert (just a warn log)
    expect(alert).not.toHaveBeenCalled()
  })

  it('10 — missing tables on first run: no crash', async () => {
    // Drop all tables temporarily
    memDb.exec('DROP TABLE IF EXISTS btc_trend_position')
    memDb.exec('DROP TABLE IF EXISTS bb_positions')
    memDb.exec('DROP TABLE IF EXISTS mom_positions')

    const alert = vi.fn().mockResolvedValue(undefined)
    await expect(reconcilePositions(async () => [], alert)).resolves.toBeUndefined()

    // Re-create tables for subsequent tests
    memDb.exec(`
      CREATE TABLE btc_trend_position (
        id INTEGER PRIMARY KEY CHECK (id = 1), direction TEXT NOT NULL,
        entry_price REAL NOT NULL DEFAULT 0, entry_ts INTEGER NOT NULL DEFAULT 0,
        quantity TEXT NOT NULL, notional REAL NOT NULL DEFAULT 0,
        month TEXT NOT NULL DEFAULT '', opened_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE bb_positions (
        symbol TEXT PRIMARY KEY, direction TEXT NOT NULL CHECK(direction IN ('long','short')),
        entry_price REAL NOT NULL DEFAULT 0, entry_ts INTEGER NOT NULL DEFAULT 0,
        quantity TEXT NOT NULL, sl_price REAL NOT NULL DEFAULT 0,
        tp_price REAL NOT NULL DEFAULT 0, notional REAL NOT NULL DEFAULT 0,
        atr_at_entry REAL NOT NULL DEFAULT 0, opened_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE mom_positions (
        symbol TEXT PRIMARY KEY, entry_price REAL NOT NULL DEFAULT 0,
        entry_ts INTEGER NOT NULL DEFAULT 0, quantity TEXT NOT NULL,
        notional REAL NOT NULL DEFAULT 0, month TEXT NOT NULL DEFAULT '',
        opened_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)
  })

  it('11 — no positions anywhere: resolves cleanly, no alert', async () => {
    const alert = vi.fn().mockResolvedValue(undefined)

    await reconcilePositions(async () => [], alert)

    expect(alert).not.toHaveBeenCalled()
  })

  it('12 — partial match: only ghost bb is cleared, live bb stays', async () => {
    insertBbPosition('LINKUSDT', 'long', '5')   // ghost
    insertBbPosition('DOTUSDT', 'short', '20')  // live
    const alert = vi.fn().mockResolvedValue(undefined)

    await reconcilePositions(
      async () => [makeBinancePosition('DOTUSDT', '-20')],
      alert,
    )

    expect(getBbRow('LINKUSDT')).toBeUndefined()
    expect(getBbRow('DOTUSDT')).toBeDefined()
    expect(alert).toHaveBeenCalledOnce()
    expect(alert.mock.calls[0][3]).toContain('LINKUSDT')
    expect(alert.mock.calls[0][3]).not.toContain('DOTUSDT')
  })
})
