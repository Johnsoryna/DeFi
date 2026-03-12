/**
 * Backtest report generator.
 * Computes performance metrics from collected backtest results.
 */
import { createLogger } from '../lib/logger.js'
import type { ResultCollector, TrackedTrade, EquityPoint, ProtocolBreakdown, ProposalBreakdown } from './resultCollector.js'

const _log = createLogger('backtest-report')

// ─── Report Types ───────────────────────────────────────────────────

export interface LeverageStats {
  avgLeverage: number
  maxLeverage: number
  leveragedTradesPct: number  // % of trades that used leverage > 1x
  avgLeveragedPnl: number    // Avg P&L for leveraged trades
  avgUnleveragedPnl: number  // Avg P&L for unleveraged trades
}

export interface ExitStats {
  stopLossExits: number
  takeProfitExits: number
  trailingStopExits: number
  maxHoldingExits: number
  liquidationExits: number
  manualExits: number
}

export interface BacktestReport {
  summary: {
    startDate: string
    endDate: string
    durationDays: number
    initialPortfolio: number
    finalPortfolio: number
    totalPnl: number
    totalPnlPct: number
    totalSignals: number
    validatedSignals: number
    executedTrades: number
    eventsReplayed: number
  }
  performance: {
    winRate: number
    profitFactor: number
    sharpeRatio: number
    maxDrawdown: number
    maxDrawdownPct: number
    avgHoldingPeriodHours: number
    avgPnlPerTrade: number
    bestTrade: number
    worstTrade: number
  }
  leverage: LeverageStats
  exits: ExitStats
  signalAccuracy: {
    totalSignals: number
    correctDirection: number
    accuracyPct: number
  }
  byProtocol: ProtocolBreakdown[]
  byProposal: ProposalBreakdown[]
  equityCurve: EquityPoint[]
}


// ─── Report Generator ───────────────────────────────────────────────

export function generateReport(
  collector: ResultCollector,
  config: { from: Date; to: Date; eventsReplayed: number; initialPortfolio: number },
): BacktestReport {
  const closedTrades = collector.trades.filter((t) => t.pnl !== null)
  const pnls = closedTrades.map((t) => t.pnl!)

  const totalPnl = pnls.reduce((sum, p) => sum + p, 0)
  const wins = pnls.filter((p) => p > 0)
  const losses = pnls.filter((p) => p < 0)

  const winRate = closedTrades.length > 0 ? wins.length / closedTrades.length : 0
  const totalWins = wins.reduce((s, p) => s + p, 0)
  const totalLosses = Math.abs(losses.reduce((s, p) => s + p, 0))
  const profitFactor = totalLosses > 0
    ? totalWins / totalLosses
    : wins.length > 0 ? 999 : 0  // 999 = "perfect" (no losses); avoids JSON null from Infinity

  const avgHoldingMs = closedTrades.length > 0
    ? closedTrades.reduce((sum, t) => sum + (t.holdingPeriodMs ?? 0), 0) / closedTrades.length
    : 0

  const sharpe = calculateSharpeRatio(collector.equityCurve)
  const maxDrawdownPct = collector.getMaxDrawdown() // This is already a fraction (0-1)
  const finalPortfolio = collector.getPortfolioValue()
  
  // Calculate absolute drawdown amount using the actual peak equity at the worst drawdown point
  const maxDrawdownAmount = collector.getMaxDrawdownAmount()

  // Signal accuracy: check if trade direction matched price movement
  const { correct, total: accuracyTotal } = calculateSignalAccuracy(closedTrades)

  // Protocol breakdown
  const byProtocol = calculateProtocolBreakdown(closedTrades)

  // Proposal breakdown
  const byProposal = calculateProposalBreakdown(closedTrades)

  const durationMs = config.to.getTime() - config.from.getTime()
  const durationDays = durationMs / (1000 * 60 * 60 * 24)

  // Leverage statistics
  const leverageStats = calculateLeverageStats(closedTrades)

  // Exit reason statistics
  const exitStats = calculateExitStats(closedTrades)

  const report: BacktestReport = {
    summary: {
      startDate: config.from.toISOString(),
      endDate: config.to.toISOString(),
      durationDays: Math.round(durationDays * 10) / 10,
      initialPortfolio: config.initialPortfolio,
      finalPortfolio: Math.round(finalPortfolio * 100) / 100,
      totalPnl: Math.round(totalPnl * 100) / 100,
      totalPnlPct: Math.round((totalPnl / config.initialPortfolio) * 10000) / 100,
      totalSignals: collector.signals.length,
      validatedSignals: collector.validatedSignals.length,
      executedTrades: collector.executions.filter((e) => e.success).length,
      eventsReplayed: config.eventsReplayed,
    },
    performance: {
      winRate: Math.round(winRate * 10000) / 100,
      profitFactor: Math.round(profitFactor * 100) / 100,
      sharpeRatio: Math.round(sharpe * 100) / 100,
      maxDrawdown: Math.round(maxDrawdownAmount * 100) / 100,
      maxDrawdownPct: Math.round(maxDrawdownPct * 10000) / 100,
      avgHoldingPeriodHours: Math.round(avgHoldingMs / 3600000 * 10) / 10,
      avgPnlPerTrade: closedTrades.length > 0
        ? Math.round((totalPnl / closedTrades.length) * 100) / 100
        : 0,
      bestTrade: pnls.length > 0 ? Math.round(Math.max(...pnls) * 100) / 100 : 0,
      worstTrade: pnls.length > 0 ? Math.round(Math.min(...pnls) * 100) / 100 : 0,
    },
    leverage: leverageStats,
    exits: exitStats,
    signalAccuracy: {
      totalSignals: accuracyTotal,
      correctDirection: correct,
      accuracyPct: accuracyTotal > 0 ? Math.round((correct / accuracyTotal) * 10000) / 100 : 0,
    },
    byProtocol,
    byProposal,
    equityCurve: collector.equityCurve,
  }

  return report
}

// ─── Sharpe Ratio ───────────────────────────────────────────────────

function calculateSharpeRatio(equityCurve: EquityPoint[]): number {
  if (equityCurve.length < 2) return 0

  // Calculate period returns
  const returns: number[] = []
  for (let i = 1; i < equityCurve.length; i++) {
    // Guard against division by zero
    if (equityCurve[i - 1].equity === 0) continue
    const ret = (equityCurve[i].equity - equityCurve[i - 1].equity) / equityCurve[i - 1].equity
    returns.push(ret)
  }

  if (returns.length === 0) return 0

  const meanReturn = returns.reduce((s, r) => s + r, 0) / returns.length
  const variance = returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / returns.length
  const stdDev = Math.sqrt(variance)

  if (stdDev === 0) return 0

  // Annualize: assume ~8760 hours/year, and each data point is roughly hourly
  // Adjust based on actual time span
  const totalMs = equityCurve[equityCurve.length - 1].timestamp - equityCurve[0].timestamp
  
  // Guard against division by zero
  if (totalMs === 0 || returns.length === 0) return 0
  
  const avgPeriodMs = totalMs / returns.length
  const periodsPerYear = (365.25 * 24 * 3600_000) / avgPeriodMs

  return (meanReturn * periodsPerYear) / (stdDev * Math.sqrt(periodsPerYear))
}

// ─── Signal Accuracy ────────────────────────────────────────────────

function calculateSignalAccuracy(trades: TrackedTrade[]): { correct: number; total: number } {
  let correct = 0
  let total = 0

  for (const trade of trades) {
    if (trade.exitPrice === null || trade.pnl === null) continue
    total++

    // A "correct" signal means the trade was profitable
    if (trade.pnl > 0) correct++
  }

  return { correct, total }
}

// ─── Protocol Breakdown ─────────────────────────────────────────────

function calculateProtocolBreakdown(trades: TrackedTrade[]): ProtocolBreakdown[] {
  const map = new Map<string, ProtocolBreakdown>()

  for (const trade of trades) {
    const protocol = trade.signal.protocol
    let entry = map.get(protocol)
    if (!entry) {
      entry = { protocol, signalCount: 0, executionCount: 0, totalPnl: 0 }
      map.set(protocol, entry)
    }

    entry.signalCount++
    if (trade.execution?.success) entry.executionCount++
    entry.totalPnl += trade.pnl ?? 0
  }

  return [...map.values()].map((b) => ({
    ...b,
    totalPnl: Math.round(b.totalPnl * 100) / 100,
  }))
}

// ─── Proposal Breakdown ─────────────────────────────────────────────

function calculateProposalBreakdown(trades: TrackedTrade[]): ProposalBreakdown[] {
  const map = new Map<string, ProposalBreakdown>()

  for (const trade of trades) {
    const proposalId = trade.signal.proposalId
    let entry = map.get(proposalId)
    if (!entry) {
      entry = { proposalId, signalCount: 0, totalPnl: 0, bestPnl: -Infinity, worstPnl: Infinity }
      map.set(proposalId, entry)
    }

    entry.signalCount++
    const pnl = trade.pnl ?? 0
    entry.totalPnl += pnl
    if (pnl > entry.bestPnl) entry.bestPnl = pnl
    if (pnl < entry.worstPnl) entry.worstPnl = pnl
  }

  return [...map.values()]
    .map((b) => ({
      ...b,
      totalPnl: Math.round(b.totalPnl * 100) / 100,
      bestPnl: b.bestPnl === -Infinity ? 0 : Math.round(b.bestPnl * 100) / 100,
      worstPnl: b.worstPnl === Infinity ? 0 : Math.round(b.worstPnl * 100) / 100,
    }))
    .sort((a, b) => b.totalPnl - a.totalPnl)
}

// ─── Leverage Statistics ─────────────────────────────────────────────

function calculateLeverageStats(trades: TrackedTrade[]): LeverageStats {
  const leverages = trades.map((t) => t.signal.leverage ?? 1)
  const leveragedTrades = trades.filter((t) => (t.signal.leverage ?? 1) > 1)
  const unleveragedTrades = trades.filter((t) => (t.signal.leverage ?? 1) <= 1)

  const avgLeverage = leverages.length > 0
    ? leverages.reduce((s, l) => s + l, 0) / leverages.length
    : 1

  return {
    avgLeverage: Math.round(avgLeverage * 10) / 10,
    maxLeverage: leverages.length > 0 ? Math.max(...leverages) : 1,
    leveragedTradesPct: trades.length > 0
      ? Math.round((leveragedTrades.length / trades.length) * 10000) / 100
      : 0,
    avgLeveragedPnl: leveragedTrades.length > 0
      ? Math.round(leveragedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0) / leveragedTrades.length * 100) / 100
      : 0,
    avgUnleveragedPnl: unleveragedTrades.length > 0
      ? Math.round(unleveragedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0) / unleveragedTrades.length * 100) / 100
      : 0,
  }
}

// ─── Exit Statistics ─────────────────────────────────────────────────

function calculateExitStats(trades: TrackedTrade[]): ExitStats {
  const stats: ExitStats = {
    stopLossExits: 0,
    takeProfitExits: 0,
    trailingStopExits: 0,
    maxHoldingExits: 0,
    liquidationExits: 0,
    manualExits: 0,
  }

  for (const trade of trades) {
    if (trade.pnl === null || trade.exitPrice === null) continue

    const reason = trade.exitReason ?? ''

    if (reason.startsWith('stop-loss') || reason.startsWith('max-loss-cap')) {
      stats.stopLossExits++
    } else if (reason.startsWith('take-profit')) {
      stats.takeProfitExits++
    } else if (reason.startsWith('trailing-stop')) {
      stats.trailingStopExits++
    } else if (reason.startsWith('max-holding-time')) {
      stats.maxHoldingExits++
    } else if (reason === 'liquidation') {
      stats.liquidationExits++
    } else {
      stats.manualExits++
    }
  }

  return stats
}

// ─── Report Formatting ──────────────────────────────────────────────

/**
 * Format a BacktestReport into a human-readable string.
 */
export function formatReport(report: BacktestReport): string {
  const lines: string[] = []
  const hr = '═'.repeat(60)

  lines.push(hr)
  lines.push('  BACKTEST REPORT')
  lines.push(hr)
  lines.push('')

  // Summary
  lines.push('  SUMMARY')
  lines.push('  ' + '─'.repeat(40))
  lines.push(`  Period:           ${report.summary.startDate.slice(0, 10)} → ${report.summary.endDate.slice(0, 10)} (${report.summary.durationDays}d)`)
  lines.push(`  Events replayed:  ${report.summary.eventsReplayed.toLocaleString()}`)
  lines.push(`  Signals:          ${report.summary.totalSignals} generated, ${report.summary.validatedSignals} validated`)
  lines.push(`  Trades executed:  ${report.summary.executedTrades}`)
  lines.push(`  Initial value:    $${report.summary.initialPortfolio.toLocaleString()}`)
  lines.push(`  Final value:      $${report.summary.finalPortfolio.toLocaleString()}`)
  lines.push(`  Total P&L:        $${report.summary.totalPnl.toLocaleString()} (${report.summary.totalPnlPct}%)`)
  lines.push('')

  // Performance
  lines.push('  PERFORMANCE')
  lines.push('  ' + '─'.repeat(40))
  lines.push(`  Win rate:         ${report.performance.winRate}%`)
  lines.push(`  Profit factor:    ${report.performance.profitFactor}`)
  lines.push(`  Sharpe ratio:     ${report.performance.sharpeRatio}`)
  lines.push(`  Max drawdown:     ${report.performance.maxDrawdownPct}%`)
  lines.push(`  Avg holding:      ${report.performance.avgHoldingPeriodHours}h`)
  lines.push(`  Avg P&L/trade:    $${report.performance.avgPnlPerTrade}`)
  lines.push(`  Best trade:       $${report.performance.bestTrade}`)
  lines.push(`  Worst trade:      $${report.performance.worstTrade}`)
  lines.push('')

  // Leverage
  lines.push('  LEVERAGE')
  lines.push('  ' + '─'.repeat(40))
  lines.push(`  Avg leverage:     ${report.leverage.avgLeverage}x`)
  lines.push(`  Max leverage:     ${report.leverage.maxLeverage}x`)
  lines.push(`  Leveraged trades: ${report.leverage.leveragedTradesPct}%`)
  lines.push(`  Avg P&L (levered):   $${report.leverage.avgLeveragedPnl}`)
  lines.push(`  Avg P&L (unlevered): $${report.leverage.avgUnleveragedPnl}`)
  lines.push('')

  // Exit reasons
  lines.push('  EXIT REASONS')
  lines.push('  ' + '─'.repeat(40))
  lines.push(`  Stop-loss:        ${report.exits.stopLossExits}`)
  lines.push(`  Take-profit:      ${report.exits.takeProfitExits}`)
  lines.push(`  Trailing stop:    ${report.exits.trailingStopExits}`)
  lines.push(`  Max holding time: ${report.exits.maxHoldingExits}`)
  lines.push(`  Near-liquidation: ${report.exits.liquidationExits}`)
  lines.push(`  Manual/other:     ${report.exits.manualExits}`)
  lines.push('')

  // Signal accuracy
  lines.push('  SIGNAL ACCURACY')
  lines.push('  ' + '─'.repeat(40))
  lines.push(`  Correct direction: ${report.signalAccuracy.correctDirection} / ${report.signalAccuracy.totalSignals} (${report.signalAccuracy.accuracyPct}%)`)
  lines.push('')

  // Protocol breakdown
  if (report.byProtocol.length > 0) {
    lines.push('  BY PROTOCOL')
    lines.push('  ' + '─'.repeat(40))
    for (const bp of report.byProtocol) {
      lines.push(`  ${bp.protocol.padEnd(10)} ${bp.signalCount} signals, ${bp.executionCount} executed, P&L: $${bp.totalPnl}`)
    }
    lines.push('')
  }

  // Top proposals
  if (report.byProposal.length > 0) {
    lines.push('  TOP PROPOSALS (by P&L)')
    lines.push('  ' + '─'.repeat(40))
    for (const bp of report.byProposal.slice(0, 10)) {
      lines.push(`  ${bp.proposalId.slice(0, 16).padEnd(18)} ${bp.signalCount} signals, P&L: $${bp.totalPnl}`)
    }
    lines.push('')
  }

  lines.push(hr)

  return lines.join('\n')
}
