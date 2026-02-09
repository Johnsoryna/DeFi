/**
 * Trade executor router.
 * Routes validated TradeSignals to the appropriate protocol executor.
 */
import { eventBus } from '../lib/eventBus.js'
import { createLogger } from '../lib/logger.js'
import { executeDydxSignal } from './dydxExecutor.js'
import { executePendleSignal } from './pendleExecutor.js'
import { executeDexSignal } from './dexExecutor.js'
import { sendAlert } from './alertService.js'
import type { TradeSignal, ExecutionResult } from '../types/trading.js'

const log = createLogger('trade-executor')

// ─── Execution Router ───────────────────────────────────────────────

/**
 * Route a validated trade signal to the appropriate executor.
 */
async function executeSignal(signal: TradeSignal): Promise<ExecutionResult> {
  log.info(
    {
      signalId: signal.id,
      asset: signal.asset,
      direction: signal.direction,
      protocol: signal.protocol,
      sizePct: signal.sizePct.toFixed(2),
      confidence: signal.confidence.toFixed(3),
    },
    'Executing trade signal',
  )

  let result: ExecutionResult

  switch (signal.protocol) {
    case 'dydx':
      result = await executeDydxSignal(signal)
      break

    case 'pendle':
      result = await executePendleSignal(signal)
      break

    case 'spot':
      result = await executeDexSignal(signal)
      break

    default:
      result = {
        success: false,
        signalId: signal.id,
        protocol: signal.protocol,
        error: `Unknown protocol: ${signal.protocol}`,
        timestamp: Date.now(),
      }
  }

  // Emit execution result
  eventBus.emit('execution:result', result)

  // Send alerts
  if (result.success) {
    await sendAlert(
      'trade_executed',
      'info',
      `Trade Executed: ${signal.direction.toUpperCase()} ${signal.asset}`,
      [
        `Protocol: ${signal.protocol}`,
        `Size: ${signal.sizePct.toFixed(2)}% of portfolio`,
        `Confidence: ${(signal.confidence * 100).toFixed(1)}%`,
        `Rationale: ${signal.rationale}`,
        result.orderId ? `Order: ${result.orderId}` : '',
        result.transactionHash ? `Tx: ${result.transactionHash}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      {
        signalId: signal.id,
        proposalId: signal.proposalId,
        stage: signal.governanceStage,
      },
    )
  } else {
    await sendAlert(
      'system_error',
      'error',
      `Trade Failed: ${signal.direction.toUpperCase()} ${signal.asset}`,
      `Error: ${result.error}\nProtocol: ${signal.protocol}\nSignal: ${signal.id}`,
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
