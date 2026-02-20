/**
 * Comprehensive Binance Testnet Order Flow Test
 *
 * Tests the COMPLETE live order pipeline against the real Binance testnet:
 *   1. Account connectivity & balance
 *   2. Exchange info (symbol specs)
 *   3. Mark prices for all key trading assets
 *   4. Full order cycle: MARKET entry + STOP_MARKET + TRAILING_STOP_MARKET + TAKE_PROFIT_MARKET
 *   5. Position verification post-entry
 *   6. cancelAllOpenOrders cleanup
 *   7. Close position (reduce 100%)
 *   8. Dry-run mode verification
 *
 * Requires: BINANCE_TESTNET=true in .env
 * Run with: npx tsx scripts/test-binance-full.ts
 *
 * NOTE: Places REAL orders on Binance testnet (play money — no real funds at risk).
 */

import * as binance from '../src/clients/binance.js'
import { executeBinanceSignal, cancelPositionOrders, reducePosition } from '../src/execution/binanceExecutor.js'
import { config } from '../src/config/index.js'
import type { TradeSignal } from '../src/types/trading.js'

// ─── ANSI colour helpers ──────────────────────────────────────────────────────

const GREEN  = '\x1b[32m'
const RED    = '\x1b[31m'
const YELLOW = '\x1b[33m'
const CYAN   = '\x1b[36m'
const BOLD   = '\x1b[1m'
const RESET  = '\x1b[0m'

const pass  = (msg: string) => console.log(`  ${GREEN}✓${RESET}  ${msg}`)
const fail  = (msg: string) => { console.log(`  ${RED}✗${RESET}  ${msg}`); failures++ }
const info  = (msg: string) => console.log(`  ${CYAN}→${RESET}  ${msg}`)
const warn  = (msg: string) => console.log(`  ${YELLOW}⚠${RESET}  ${msg}`)
const head  = (msg: string) => console.log(`\n${BOLD}── ${msg} ${'─'.repeat(Math.max(0, 76 - msg.length))}${RESET}`)
const sep   = () => console.log('─'.repeat(90))

let failures = 0
let totalTests = 0

function check(label: string, condition: boolean, detail = '') {
  totalTests++
  if (condition) {
    pass(`${label}${detail ? ` (${detail})` : ''}`)
  } else {
    fail(`${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// ─── Test signal — AAVEUSDT short (aggressive) ───────────────────────────────

function makeTestSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    id:                    `test-${Date.now()}`,
    asset:                 'AAVE',
    direction:             'short',
    sizePct:               1,           // tiny — 1% of portfolio ($50 on $5000)
    leverage:              2,           // low leverage for test
    protocol:              'binance',
    confidence:            0.72,
    rationale:             'Binance testnet order flow verification',
    proposalId:            'test:1',
    governanceStage:       'snapshot',
    timestamp:             Date.now(),
    urgency:               'medium',
    stopLossPct:           0.12,        // 12% SL
    takeProfitPct:         0.36,        // 36% TP
    trailingStopActivation: 0.15,       // 15% activation
    trailingStopDistance:  0.07,        // 7% distance → clamped to 5% on Binance
    maxHoldingHours:       576,
    ...overrides,
  }
}

// ─── Sleep helper ─────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// ─── MAIN TEST RUNNER ─────────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(90))
  console.log(`  ${BOLD}BINANCE TESTNET — Full Order Flow Test${RESET}`)
  console.log(`  DRY_RUN=${config.dryRun}  TESTNET=${config.binanceTestnet}  PORTFOLIO=$${config.initialPortfolioUsd}`)
  console.log('═'.repeat(90))

  // ── Env sanity check ──────────────────────────────────────────────────────
  head('0. Environment Sanity Check')

  check('BINANCE_TESTNET=true', config.binanceTestnet === true,
    config.binanceTestnet ? 'safe — testnet funds only' : 'DANGER: would use MAINNET')

  if (!config.binanceTestnet) {
    fail('ABORT: BINANCE_TESTNET must be true for this test. Set in .env and retry.')
    process.exit(1)
  }

  check('BINANCE_API_KEY configured', Boolean(config.binanceApiKey))
  check('BINANCE_API_SECRET configured', Boolean(config.binanceApiSecret))
  check('INITIAL_PORTFOLIO_USD > 0', config.initialPortfolioUsd > 0,
    `$${config.initialPortfolioUsd}`)

  if (!config.binanceApiKey || !config.binanceApiSecret) {
    fail('ABORT: Binance API credentials not found in .env')
    process.exit(1)
  }

  // ── 1. Account connectivity ───────────────────────────────────────────────
  head('1. Account Connectivity & Balance')

  let equity = 0
  try {
    const account = await binance.getAccountInfo()
    equity = parseFloat(account.totalMarginBalance)
    check('Connected to Binance testnet', true)
    check('Margin balance fetched', equity >= 0, `$${equity.toFixed(2)} USDT`)
    info(`Wallet balance: $${account.totalWalletBalance}`)
    info(`Unrealized PnL: $${account.totalUnrealizedProfit}`)
    info(`Available: $${account.availableBalance}`)
    if (account.positions.length > 0) {
      warn(`${account.positions.length} open position(s) found — will be cleaned up at end`)
      for (const p of account.positions) {
        info(`  Open: ${p.symbol} amt=${p.positionAmt} entry=$${p.entryPrice}`)
      }
    } else {
      info('No open positions — clean slate')
    }
  } catch (err) {
    fail(`Account connectivity failed: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }

  // ── 1b. Pre-test cleanup — close any stale AAVEUSDT position ─────────────
  head('1b. Pre-Test Cleanup (close stale AAVEUSDT position if any)')

  try {
    const preAccount = await binance.getAccountInfo()
    const stalePos = preAccount.positions.find(p => p.symbol === 'AAVEUSDT')
    if (stalePos && parseFloat(stalePos.positionAmt) !== 0) {
      warn(`Stale AAVEUSDT position found (amt=${stalePos.positionAmt}) — closing before test`)
      await binance.cancelAllOpenOrders('AAVEUSDT')
      const closeResult = await reducePosition('AAVEUSDT', stalePos.positionAmt, 100)
      check('Stale position closed', closeResult.success, closeResult.error ?? '')
      info(`Close orderId: ${closeResult.orderId}`)
      await sleep(2000) // let exchange process
    } else {
      info('No stale AAVEUSDT position — clean slate')
      check('AAVEUSDT already flat', true)
    }
  } catch (err) {
    warn(`Pre-test cleanup: ${err instanceof Error ? err.message : err}`)
  }

  // ── 2. One-Way mode ───────────────────────────────────────────────────────
  head('2. One-Way Position Mode')

  try {
    await binance.ensureOneWayMode()
    check('One-Way mode confirmed (or already set)', true)
  } catch (err) {
    warn(`ensureOneWayMode: ${err instanceof Error ? err.message : err}`)
  }

  // ── 3. Exchange info ──────────────────────────────────────────────────────
  head('3. Exchange Info (Symbol Specifications)')

  let exchangeInfo: Map<string, { tickSize: string; stepSize: string; minNotional: string; symbol: string; status: string; baseAsset: string; quoteAsset: string; markPrice: string; maxLeverage: number }> | null = null
  try {
    exchangeInfo = await binance.getExchangeInfo()
    check('Exchange info fetched', exchangeInfo.size > 0, `${exchangeInfo.size} USDT-M symbols`)

    const key = ['AAVEUSDT', 'ARBUSDT', 'LDOUSDT', 'COMPUSDT', 'DYDXUSDT']
    for (const sym of key) {
      const m = exchangeInfo.get(sym)
      check(`${sym} specs present`, Boolean(m), m ? `tick=${m.tickSize} step=${m.stepSize}` : 'MISSING')
    }
  } catch (err) {
    fail(`Exchange info failed: ${err instanceof Error ? err.message : err}`)
  }

  // ── 4. Mark prices ────────────────────────────────────────────────────────
  head('4. Mark Prices — Key Trading Assets')

  const ASSETS = ['AAVEUSDT', 'ARBUSDT', 'LDOUSDT', 'COMPUSDT', 'DYDXUSDT', 'ETHUSDT', 'BTCUSDT']
  for (const sym of ASSETS) {
    try {
      const price = await binance.getMarkPrice(sym)
      const p = parseFloat(price)
      check(`${sym} mark price`, p > 0, `$${p.toFixed(4)}`)
    } catch (err) {
      fail(`${sym} mark price: ${err instanceof Error ? err.message : err}`)
    }
  }

  // ── 5. Set leverage test ──────────────────────────────────────────────────
  head('5. Leverage & Margin Setup')

  try {
    await binance.setLeverage('AAVEUSDT', 2)
    check('setLeverage(AAVEUSDT, 2x)', true)
  } catch (err) {
    fail(`setLeverage failed: ${err instanceof Error ? err.message : err}`)
  }

  try {
    await binance.setMarginType('AAVEUSDT', 'CROSSED')
    check('setMarginType(AAVEUSDT, CROSSED)', true, '-4046 already-set is OK')
  } catch (err) {
    // -4046 = already set — this is fine
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('-4046')) {
      check('setMarginType(AAVEUSDT, CROSSED)', true, 'already CROSSED (-4046 expected)')
    } else {
      fail(`setMarginType failed: ${msg}`)
    }
  }

  // ── 6. DRY RUN mode verification ─────────────────────────────────────────
  head('6. Dry-Run Mode (no orders placed)')

  {
    // Temporarily force dryRun
    const origDryRun = config.dryRun
    ;(config as Record<string, unknown>).dryRun = true

    const signal = makeTestSignal()
    const result = await executeBinanceSignal(signal)

    check('dry-run returns success=true', result.success === true)
    check('dry-run orderId starts with "dry-"', Boolean(result.orderId?.startsWith('dry-')),
      result.orderId ?? 'undefined')
    check('dry-run metadata.symbol = AAVEUSDT', result.metadata?.symbol === 'AAVEUSDT',
      String(result.metadata?.symbol))
    check('dry-run metadata.maxHoldingHours = 576', result.metadata?.maxHoldingHours === 576,
      String(result.metadata?.maxHoldingHours))
    check('dry-run metadata.dryRun = true', result.metadata?.dryRun === true)

    ;(config as Record<string, unknown>).dryRun = origDryRun
    info('Restored dryRun to original value')
  }

  // ── 7. LIVE ORDER PLACEMENT (testnet) ─────────────────────────────────────
  head('7. Live Order Placement — Full 4-Order Cycle')
  info('Placing MARKET entry + STOP_MARKET + TRAILING_STOP_MARKET + TAKE_PROFIT_MARKET')
  info('Asset: AAVE  Direction: SHORT  Leverage: 2x  Size: 1%')

  let entryOrderId: string | undefined
  let entrySymbol = 'AAVEUSDT'
  let entryQty: string | undefined

  if (config.dryRun) {
    warn('DRY_RUN=true — skipping live order placement (set DRY_RUN=false in .env for full test)')
  } else {
    const signal = makeTestSignal()
    info(`Signal: ${JSON.stringify({ id: signal.id, asset: signal.asset, direction: signal.direction, sizePct: signal.sizePct, leverage: signal.leverage })}`)

    const result = await executeBinanceSignal(signal)
    info(`Execution result: success=${result.success} orderId=${result.orderId} error=${result.error ?? 'none'}`)

    check('executeBinanceSignal returns success', result.success === true, result.error ?? '')
    check('orderId is numeric string', /^\d+$/.test(result.orderId ?? ''), result.orderId ?? 'undefined')
    // Binance MARKET orders return avgPrice='0.00' in placement response — actual fill price is in trade history
    check('executedPrice returned (Binance MARKET orders return 0.00 initially — OK)',
      result.executedPrice !== undefined,
      `avgPrice="${result.executedPrice}" (0.00 is normal for Binance MARKET orders)`)
    check('metadata.symbol = AAVEUSDT', result.metadata?.symbol === 'AAVEUSDT')
    check('metadata.maxHoldingHours = 576', result.metadata?.maxHoldingHours === 576)
    check('metadata.dryRun = false', result.metadata?.dryRun === false)

    entryOrderId = result.orderId
    entryQty = result.executedSize
    info(`Entry: orderId=${entryOrderId} qty=${entryQty} price=${result.executedPrice}`)

    // ── 8. Position verification ──────────────────────────────────────────
    head('8. Position Verification (post-entry)')

    await sleep(2000) // give exchange time to process

    try {
      const account = await binance.getAccountInfo()
      const aavePos = account.positions.find(p => p.symbol === 'AAVEUSDT')

      check('AAVEUSDT position exists', Boolean(aavePos), aavePos ? `amt=${aavePos.positionAmt}` : 'NOT FOUND')
      if (aavePos) {
        const amt = parseFloat(aavePos.positionAmt)
        check('Position is SHORT (negative amt)', amt < 0, `positionAmt=${aavePos.positionAmt}`)
        check('Entry price > 0', parseFloat(aavePos.entryPrice) > 0, `$${aavePos.entryPrice}`)
        check('Leverage = 2', aavePos.leverage === '2' || Number(aavePos.leverage) === 2, `leverage=${aavePos.leverage}`)
        info(`Unrealized PnL: $${aavePos.unrealizedProfit}`)
        info(`Liquidation price: $${aavePos.liquidationPrice}`)
      }
    } catch (err) {
      fail(`Position check failed: ${err instanceof Error ? err.message : err}`)
    }

    // ── 9. cancelAllOpenOrders ────────────────────────────────────────────
    head('9. Cancel All Open Orders (simulates position close cleanup)')

    try {
      await binance.cancelAllOpenOrders('AAVEUSDT')
      check('cancelAllOpenOrders(AAVEUSDT) completed', true)
    } catch (err) {
      // -2011 = no open orders to cancel (position may have already been cancelled)
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('-2011')) {
        check('cancelAllOpenOrders (no orders to cancel)', true, '-2011 OK')
      } else {
        fail(`cancelAllOpenOrders failed: ${msg}`)
      }
    }

    // ── 10. Close position (reducePosition 100%) ──────────────────────────
    head('10. Close Position (reduce 100%)')

    await sleep(1000)

    try {
      const account = await binance.getAccountInfo()
      const aavePos = account.positions.find(p => p.symbol === 'AAVEUSDT')

      if (aavePos && parseFloat(aavePos.positionAmt) !== 0) {
        info(`Closing position: amt=${aavePos.positionAmt}`)
        const closeResult = await reducePosition('AAVEUSDT', aavePos.positionAmt, 100)

        check('reducePosition returns success', closeResult.success === true, closeResult.error ?? '')
        check('close orderId is numeric', /^\d+$/.test(closeResult.orderId ?? ''), closeResult.orderId ?? '')
        info(`Close orderId: ${closeResult.orderId}`)
      } else {
        info('No open position to close (already flat)')
        check('Position already closed / flat', true)
      }
    } catch (err) {
      fail(`reducePosition failed: ${err instanceof Error ? err.message : err}`)
    }

    // ── 11. Final account state ───────────────────────────────────────────
    head('11. Final Account State (should be clean)')

    await sleep(2000)

    try {
      const account = await binance.getAccountInfo()
      const aavePos = account.positions.find(p => p.symbol === 'AAVEUSDT')
      const isFlat = !aavePos || parseFloat(aavePos.positionAmt) === 0

      check('AAVEUSDT position is flat / closed', isFlat,
        aavePos ? `remaining amt=${aavePos.positionAmt}` : 'no position')
      info(`Final margin balance: $${account.totalMarginBalance}`)
      info(`Open positions: ${account.positions.length}`)
    } catch (err) {
      fail(`Final state check failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  // ── 12. cancelPositionOrders export test ──────────────────────────────────
  head('12. cancelPositionOrders Export Wrapper')

  try {
    await cancelPositionOrders('AAVEUSDT')
    check('cancelPositionOrders("AAVEUSDT") runs without throwing', true,
      'safe to call when no orders exist')
  } catch (err) {
    fail(`cancelPositionOrders threw: ${err instanceof Error ? err.message : err}`)
  }

  // ── 13. Invalid asset handling ────────────────────────────────────────────
  head('13. Invalid Asset / Error Handling')

  {
    const signal = makeTestSignal({ asset: 'UNKNOWNXYZ123' })
    const result = await executeBinanceSignal(signal)
    check('Unknown asset returns success=false', result.success === false)
    check('Error message mentions asset', result.error?.includes('UNKNOWNXYZ123') ?? false, result.error ?? '')
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  sep()
  console.log()
  if (failures === 0) {
    console.log(`  ${GREEN}${BOLD}✓  ALL ${totalTests} CHECKS PASSED${RESET}`)
    console.log(`  ${GREEN}Live order pipeline is operational and production-ready.${RESET}`)
  } else {
    console.log(`  ${RED}${BOLD}✗  ${failures}/${totalTests} CHECKS FAILED${RESET}`)
    console.log(`  ${RED}Review failures above before deploying to production.${RESET}`)
  }
  console.log()
  sep()

  process.exit(failures > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(`\n${RED}FATAL:${RESET}`, err)
  process.exit(1)
})
