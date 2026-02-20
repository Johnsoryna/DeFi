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
