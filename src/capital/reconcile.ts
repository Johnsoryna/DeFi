/**
 * Position Reconciliation — startup cross-check between layer DBs and Binance.
 *
 * Problem: a position can be closed externally (manual trade, stop-loss hit during
 * downtime, bot crash mid-close) while the DB still shows it as open. On the next
 * restart, the layer would believe it already has an open position and skip the next
 * monthly rebalance (btc-trend/momentum) or block re-entry (bb-bounce).
 *
 * Solution: at startup, cross-check every layer's DB rows against live Binance positions.
 * Any row in the DB for a symbol not open on Binance is a ghost — clear it immediately.
 *
 * Coverage:
 *   btc_trend_position — single BTC trend row (id = 1)
 *   bb_positions       — one row per symbol (bb_bounce layer)
 *   mom_positions      — one row per symbol (momentum layer)
 *
 * Governance layer positions are tracked via the live Binance position tracker
 * (currentPositions in index.ts) and do not need separate reconciliation.
 *
 * Design: dependency-injected I/O functions for testability — no real API calls in tests.
 */
import { createLogger } from '../lib/logger.js'
import { getDb } from '../lib/store.js'
import { getPositions } from '../clients/binance.js'
import { sendAlert } from '../execution/alertService.js'
import type { BinancePosition } from '../types/protocol.js'

const log = createLogger('reconcile')

type GetPositionsFn = () => Promise<BinancePosition[]>
type SendAlertFn = typeof sendAlert

/**
 * Cross-check all layer DB positions against live Binance open positions.
 * Clears ghost rows (DB open, Binance closed) and warns on unknown Binance positions.
 *
 * @param getBinancePositions - injectable for testing (defaults to real Binance API)
 * @param alert               - injectable for testing (defaults to real sendAlert)
 */
export async function reconcilePositions(
  getBinancePositions: GetPositionsFn = getPositions,
  alert: SendAlertFn = sendAlert,
): Promise<void> {
  let livePositions: BinancePosition[]
  try {
    livePositions = await getBinancePositions()
  } catch (err) {
    log.warn({ err }, 'Reconcile: Binance fetch failed — skipping (fail-open)')
    return
  }

  // Symbols with an actual open position on Binance (positionAmt ≠ 0, already filtered by getPositions)
  const openOnBinance = new Set(livePositions.map(p => p.symbol))

  const db = getDb()
  const cleared: string[] = []

  // ── 1. BTC Trend (single row, id = 1) ─────────────────────────────────────
  try {
    const row = db
      .prepare('SELECT direction, quantity FROM btc_trend_position WHERE id = 1')
      .get() as { direction: string; quantity: string } | undefined
    if (row && !openOnBinance.has('BTCUSDT')) {
      db.prepare('DELETE FROM btc_trend_position WHERE id = 1').run()
      cleared.push(`BTC Trend ${row.direction.toUpperCase()} qty=${row.quantity}`)
      log.warn(
        { direction: row.direction, qty: row.quantity },
        'Reconcile: ghost btc_trend_position cleared — closed externally',
      )
    }
  } catch { /* table may not exist on first-ever startup */ }

  // ── 2. BB Bounce (one row per symbol) ─────────────────────────────────────
  try {
    const rows = db
      .prepare('SELECT symbol, direction, quantity FROM bb_positions')
      .all() as { symbol: string; direction: string; quantity: string }[]
    for (const row of rows) {
      if (!openOnBinance.has(row.symbol)) {
        db.prepare('DELETE FROM bb_positions WHERE symbol = ?').run(row.symbol)
        cleared.push(`BB ${row.symbol} ${row.direction.toUpperCase()} qty=${row.quantity}`)
        log.warn(
          { symbol: row.symbol, direction: row.direction },
          'Reconcile: ghost bb_position cleared — closed externally',
        )
      }
    }
  } catch { /* table may not exist on first-ever startup */ }

  // ── 3. Momentum (one row per symbol) ──────────────────────────────────────
  try {
    const rows = db
      .prepare('SELECT symbol, quantity FROM mom_positions')
      .all() as { symbol: string; quantity: string }[]
    for (const row of rows) {
      if (!openOnBinance.has(row.symbol)) {
        db.prepare('DELETE FROM mom_positions WHERE symbol = ?').run(row.symbol)
        cleared.push(`Momentum ${row.symbol} qty=${row.quantity}`)
        log.warn(
          { symbol: row.symbol },
          'Reconcile: ghost mom_position cleared — closed externally',
        )
      }
    }
  } catch { /* table may not exist on first-ever startup */ }

  // ── 4. Warn on Binance positions unknown to any layer ─────────────────────
  // Build set of all symbols our layers are supposed to be tracking
  const trackedByLayers = new Set<string>(['BTCUSDT'])
  try {
    const bb = db.prepare('SELECT symbol FROM bb_positions').all() as { symbol: string }[]
    bb.forEach(r => trackedByLayers.add(r.symbol))
    const mom = db.prepare('SELECT symbol FROM mom_positions').all() as { symbol: string }[]
    mom.forEach(r => trackedByLayers.add(r.symbol))
  } catch { /* ignore */ }

  for (const pos of livePositions) {
    if (!trackedByLayers.has(pos.symbol)) {
      log.warn(
        { symbol: pos.symbol, positionAmt: pos.positionAmt },
        'Reconcile: untracked Binance position — manual trade or external position',
      )
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  if (cleared.length > 0) {
    log.warn({ count: cleared.length, cleared }, 'Reconcile complete — ghost positions removed')
    await alert(
      'system_health',
      'warning',
      `${cleared.length} Ghost Position(s) Cleared`,
      `DB had open position(s) not found on Binance (closed externally during downtime):\n` +
        cleared.map(c => `• ${c}`).join('\n') +
        '\n\nDB state corrected. Next rebalance will open fresh positions.',
    ).catch(() => {})
  } else {
    log.info('Reconcile complete — all layer DB positions match Binance')
  }
}
