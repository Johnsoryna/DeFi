/**
 * Trade executor router.
 * Routes validated TradeSignals to the Binance Futures executor.
 *
 * All trading goes through Binance USDT-M perpetual futures.
 */
import { eventBus } from '../lib/eventBus.js'
import { createLogger } from '../lib/logger.js'
import { executeBinanceSignal } from './binanceExecutor.js'
import { sendAlert } from './alertService.js'
import type { TradeSignal, ExecutionResult } from '../types/trading.js'

const log = createLogger('trade-executor')

// ─── Duplicate Signal Guard ──────────────────────────────────────────
// Prevents the same proposal+stage+direction from executing twice within 60s.
// Root cause: two analysis paths (e.g. on-chain + forum) can emit signals for
// the same event before the first execution is reflected in currentPositions,
// causing both to pass the RiskManager exposure check simultaneously.

const recentExecutions = new Map<string, number>() // key → timestamp

function isDuplicateSignal(signal: TradeSignal): boolean {
  // Lazily clean up entries older than 5 minutes
  const cutoff = Date.now() - 5 * 60_000
  for (const [key, ts] of recentExecutions) {
    if (ts < cutoff) recentExecutions.delete(key)
  }
  const key = `${signal.proposalId ?? signal.id}:${signal.governanceStage ?? ''}:${signal.direction}:${signal.asset}`
  const last = recentExecutions.get(key)
  if (last && Date.now() - last < 60_000) return true
  recentExecutions.set(key, Date.now())
  return false
}

// ─── Execution Router ───────────────────────────────────────────────

/**
 * Execute a validated trade signal via Binance Futures.
 */
async function executeSignal(signal: TradeSignal): Promise<ExecutionResult> {
  log.info(
    {
      signalId: signal.id,
      asset: signal.asset,
      direction: signal.direction,
      sizePct: signal.sizePct.toFixed(2),
      leverage: (signal.leverage ?? 1).toFixed(1) + 'x',
      confidence: signal.confidence.toFixed(3),
      stopLoss: signal.stopLossPct ? (signal.stopLossPct * 100).toFixed(1) + '%' : 'none',
      takeProfit: signal.takeProfitPct ? (signal.takeProfitPct * 100).toFixed(1) + '%' : 'none',
    },
    'Executing trade signal',
  )

  const result = await executeBinanceSignal(signal)

  // Emit execution result
  eventBus.emit('execution:result', result)

  // Send alerts
  if (result.success) {
    await sendAlert(
      'trade_executed',
      'info',
      `Trade Executed: ${signal.direction.toUpperCase()} ${signal.asset}`,
      [
        `Size: ${signal.sizePct.toFixed(2)}% of portfolio`,
        signal.leverage && signal.leverage > 1 ? `Leverage: ${signal.leverage}x` : '',
        `Confidence: ${(signal.confidence * 100).toFixed(1)}%`,
        signal.stopLossPct ? `Stop-Loss: ${(signal.stopLossPct * 100).toFixed(1)}%` : '',
        signal.takeProfitPct ? `Take-Profit: ${(signal.takeProfitPct * 100).toFixed(1)}%` : '',
        `Rationale: ${signal.rationale}`,
        result.orderId ? `Order: ${result.orderId}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      {
        signalId: signal.id,
        proposalId: signal.proposalId,
        stage: signal.governanceStage,
        leverage: signal.leverage ?? 1,
      },
    )
  } else if (result.skipped) {
    // Asset has no Binance Futures perp — not a bug, just skip quietly
    log.info(
      { asset: signal.asset, signalId: signal.id, reason: result.error },
      'Signal skipped — no Binance Futures perp for asset',
    )
  } else {
    await sendAlert(
      'system_error',
      'error',
      `Trade Failed: ${signal.direction.toUpperCase()} ${signal.asset}`,
      `Error: ${result.error}\nSignal: ${signal.id}`,
      { signalId: signal.id, error: result.error },
    )
  }

  return result
}

// ─── Event Bus Integration ──────────────────────────────────────────

/**
 * Wire the trade executor to the event bus.
 * Listens for signal:validated events from the risk manager.
 */
export function wireTradeExecutor(): void {
  eventBus.on('signal:validated', (signal: TradeSignal) => {
    if (isDuplicateSignal(signal)) {
      log.warn(
        { proposalId: signal.proposalId, stage: signal.governanceStage, asset: signal.asset, direction: signal.direction },
        'Duplicate signal suppressed — same proposal+stage+direction within 60s (race condition guard)',
      )
      return
    }
    executeSignal(signal).catch((err) => {
      log.error({ err, signalId: signal.id }, 'Unhandled execution error')
    })
  })

  log.info('Trade executor wired to event bus')
}

/**
 * Execute a trade signal directly (bypasses event bus).
 */
export { executeSignal }
