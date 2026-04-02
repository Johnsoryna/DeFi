#!/usr/bin/env node
/**
 * Exhaustive Parameter Grid Sweep — DeFi Governance Bot
 * ═══════════════════════════════════════════════════════════════════════════
 * Systematically sweeps discrete/non-delta parameters that cannot be
 * efficiently explored by the delta-based OODA loop.
 *
 * Anti-overfitting contract (ALL must pass):
 *   1. Full-period backtest composite score ≥ baseline
 *   2. WFO ≥ 11/13 periods profitable (robustness-check.ts gate)
 *   3. Overall robustness ≥ 97.0% (from robustness-check.ts)
 *
 * Parameter groups:
 *   A: Signal sizePct (7 signal types in signalGenerator.ts)
 *   B: Liquidity leverage caps per protocol (LIQUIDITY_LEV_CAP)
 *   C: Risk timing (minHoldBeforeSL, decayFloor, decayStart, maxAbsLoss)
 *   D: Momentum thresholds (A3 14d, A3 3d, exhausted-move 7d)
 *   E: Heat cap (max open positions)
 *
 * Usage:
 *   node scripts/param-grid-sweep.mjs                  # full run
 *   node scripts/param-grid-sweep.mjs --dry-run        # plan only, no backtests
 *   node scripts/param-grid-sweep.mjs --group A        # only run group A
 *   node scripts/param-grid-sweep.mjs --skip-wfo       # skip WFO gate (faster, less safe)
 *   node scripts/param-grid-sweep.mjs --verbose        # show backtest output
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const REPORT_PATH = join(ROOT, 'data', 'backtest-report.json')

// ─── CLI flags ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const DRY_RUN  = args.includes('--dry-run')
const VERBOSE  = args.includes('--verbose')
const SKIP_WFO = args.includes('--skip-wfo')
const ONLY_GROUP = (() => { const i = args.indexOf('--group'); return i !== -1 ? args[i + 1] : null })()

// ─── File paths ─────────────────────────────────────────────────────────────
const FILES = {
  signalGenerator:  join(ROOT, 'src', 'strategy', 'signalGenerator.ts'),
  resultCollector:  join(ROOT, 'src', 'backtest', 'resultCollector.ts'),
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function escRe(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
function fmt(n) { return typeof n === 'number' ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : String(n) }
function lerp(a, b, t) { return a + (b - a) * Math.max(0, Math.min(1, t)) }

function readReport() {
  const raw = JSON.parse(readFileSync(REPORT_PATH, 'utf-8'))
  const s = raw.summary || {}
  const p = raw.performance || {}
  return {
    winRate:        p.winRate        ?? 0,
    totalPnl:       s.totalPnl       ?? 0,
    maxDrawdownPct: p.maxDrawdownPct ?? 0,
    executedTrades: s.executedTrades ?? 0,
    profitFactor:   p.profitFactor   ?? 0,
  }
}

function compositeScore(m) {
  const { winRate, totalPnl, maxDrawdownPct, executedTrades, profitFactor } = m

  const wrScore = winRate >= 82 ? 100
    : winRate >= 65 ? lerp(50, 100, (winRate - 65) / 17)
    : lerp(0, 50, winRate / 65)

  const pnlScore = totalPnl >= 120_000 ? 100
    : totalPnl >= 80_000 ? lerp(50, 100, (totalPnl - 80_000) / 40_000)
    : totalPnl > 0 ? lerp(0, 50, totalPnl / 80_000)
    : 0

  const ddScore = maxDrawdownPct <= 10 ? 100
    : maxDrawdownPct <= 15 ? lerp(75, 100, (15 - maxDrawdownPct) / 5)
    : maxDrawdownPct <= 25 ? lerp(40, 75, (25 - maxDrawdownPct) / 10)
    : maxDrawdownPct <= 35 ? lerp(0, 40, (35 - maxDrawdownPct) / 10)
    : 0

  const tcScore = executedTrades >= 25 && executedTrades <= 40 ? 100
    : executedTrades >= 15 && executedTrades < 25 ? lerp(40, 100, (executedTrades - 15) / 10)
    : executedTrades > 40 && executedTrades <= 55 ? lerp(60, 100, (55 - executedTrades) / 15)
    : executedTrades > 55 ? 20 : 10

  const pfCapped = Math.min(profitFactor, 10)
  const pfScore = pfCapped >= 3.5 ? 100
    : pfCapped >= 2.0 ? lerp(50, 100, (pfCapped - 2.0) / 1.5)
    : pfCapped >= 1.0 ? lerp(0, 50, (pfCapped - 1.0) / 1.0)
    : 0

  return Math.round((wrScore * 0.30 + pnlScore * 0.30 + ddScore * 0.20 + tcScore * 0.10 + pfScore * 0.10) * 10) / 10
}

function runBacktest() {
  const cmd = 'npx tsx src/backtest/index.ts run --from 2025-01-01 --to 2026-02-20'
  const t0 = Date.now()
  try {
    execSync(cmd, { cwd: ROOT, stdio: VERBOSE ? 'inherit' : 'ignore', timeout: 600_000 })
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    if (VERBOSE) console.log(`  ✓ Backtest done in ${elapsed}s`)
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message.slice(0, 200) }
  }
}

function runWfoCheck() {
  try {
    const out = execSync('npx tsx scripts/robustness-check.ts', {
      cwd: ROOT, timeout: 900_000,
      // pipe stdout+stderr so we can parse
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString()

    // Parse WFO score: "Walk-Forward Score: 12/13 periods"
    const wfoM = out.match(/Walk-Forward Score:\s*(\d+)\/(\d+)/)
    const wfoProfitable = wfoM ? parseInt(wfoM[1]) : 0
    const wfoTotal = wfoM ? parseInt(wfoM[2]) : 13

    // Parse overall robustness: "OVERALL ROBUSTNESS: 97.5%"
    const robM = out.match(/OVERALL ROBUSTNESS:\s*([\d.]+)%/)
    const robustness = robM ? parseFloat(robM[1]) : 0

    return { success: true, wfoProfitable, wfoTotal, robustness }
  } catch (e) {
    // robustness-check exits non-zero if WFO < threshold; still capture output
    const output = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '')
    const wfoM = output.match(/Walk-Forward Score:\s*(\d+)\/(\d+)/)
    const wfoProfitable = wfoM ? parseInt(wfoM[1]) : 0
    const wfoTotal = wfoM ? parseInt(wfoM[2]) : 13
    const robM = output.match(/OVERALL ROBUSTNESS:\s*([\d.]+)%/)
    const robustness = robM ? parseFloat(robM[1]) : 0
    return { success: false, wfoProfitable, wfoTotal, robustness, error: e.message.slice(0, 100) }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PARAMETER DEFINITIONS
// Each param defines:
//   id, name, file, current, values, apply(content, newVal) → newContent
// The apply() function replaces the value using anchored regex.
// ═══════════════════════════════════════════════════════════════════════════

const PARAM_GROUPS = [

  // ─── GROUP A: Signal sizePct ────────────────────────────────────────────
  {
    name: 'A',
    label: 'Signal sizePct',
    params: [
      {
        id: 'sizePct_ltv_short',
        name: 'sizePct LTV/LT direct short',
        file: 'signalGenerator',
        current: 5,
        values: [3, 4, 5, 6, 7],
        // Anchor: "(isDecrease ? 5 : 3)" in the ltv_change/LT block
        apply(content, v) {
          const re = /(isDecrease \? )(\d+)( : 3\))/
          if (!re.test(content)) throw new Error('sizePct_ltv_short pattern not found')
          return content.replace(re, `$1${v}$3`)
        },
        read(content) {
          const m = content.match(/isDecrease \? (\d+) : 3\)/)
          return m ? parseInt(m[1]) : null
        },
      },
      {
        id: 'sizePct_reserve_freeze',
        name: 'sizePct reserve_freeze',
        file: 'signalGenerator',
        current: 5,
        values: [4, 5, 6, 7, 8],
        // Anchor: unique "rationale: `Reserve freeze" — use \r\n for Windows CRLF
        apply(content, v) {
          const re = /(sizePct:\s*)(\d+)(,[\r\n]+\s+urgency: 'high',[\r\n]+\s+rationale: `Reserve freeze)/
          if (!re.test(content)) throw new Error('sizePct_reserve_freeze pattern not found')
          return content.replace(re, `$1${v}$3`)
        },
        read(content) {
          const m = content.match(/sizePct:\s*(\d+),[\r\n]+\s+urgency: 'high',[\r\n]+\s+rationale: `Reserve freeze/)
          return m ? parseInt(m[1]) : null
        },
      },
      {
        id: 'sizePct_direct_risk_short',
        name: 'sizePct direct asset risk short',
        file: 'signalGenerator',
        current: 6,
        values: [4, 5, 6, 7, 8],
        // Anchor: unique comment "// Higher size for proven alpha" on same line
        apply(content, v) {
          const re = /(sizePct:\s*)(\d+)(,\s*\/\/ Higher size for proven alpha)/
          if (!re.test(content)) throw new Error('sizePct_direct_risk_short pattern not found')
          return content.replace(re, `$1${v}$3`)
        },
        read(content) {
          const m = content.match(/sizePct:\s*(\d+),\s*\/\/ Higher size for proven alpha/)
          return m ? parseInt(m[1]) : null
        },
      },
      {
        id: 'sizePct_cascade_hebel4',
        name: 'sizePct Hebel-4 cascade',
        file: 'signalGenerator',
        current: 4,
        values: [3, 4, 5, 6],
        // Anchor: rationale "Collateral-issuer cascade" — use flexible newline for CRLF/LF
        apply(content, v) {
          const re = /(sizePct:\s*)(\d+)(,[\r\n]+\s+urgency: 'medium',[\r\n]+\s+rationale: `Collateral-issuer cascade)/
          if (!re.test(content)) throw new Error('sizePct_cascade_hebel4 pattern not found')
          return content.replace(re, `$1${v}$3`)
        },
        read(content) {
          const m = content.match(/sizePct:\s*(\d+),[\r\n]+\s+urgency: 'medium',[\r\n]+\s+rationale: `Collateral-issuer cascade/)
          return m ? parseInt(m[1]) : null
        },
      },
      {
        id: 'sizePct_stablecoin_risk',
        name: 'sizePct stablecoin risk → gov token',
        file: 'signalGenerator',
        current: 5,
        values: [3, 4, 5, 6],
        // Anchor: "Keep aggressive risk profile" is on the urgency line (CRLF between fields)
        apply(content, v) {
          const re = /(sizePct:\s*)(\d+)(,[\r\n]+\s+urgency: 'high',\s+\/\/ Keep aggressive risk profile)/
          if (!re.test(content)) throw new Error('sizePct_stablecoin_risk pattern not found')
          return content.replace(re, `$1${v}$3`)
        },
        read(content) {
          const m = content.match(/sizePct:\s*(\d+),[\r\n]+\s+urgency: 'high',\s+\/\/ Keep aggressive risk profile/)
          return m ? parseInt(m[1]) : null
        },
      },
      {
        id: 'sizePct_cap_change',
        name: 'sizePct cap_change',
        file: 'signalGenerator',
        current: 2,
        values: [1, 2, 3, 4],
        // Anchor: rationale "isDecrease ? `Cap decrease" — use flexible newline for CRLF/LF
        apply(content, v) {
          const re = /(sizePct:\s*)(\d+)(,[\r\n]+\s+urgency: 'medium',[\r\n]+\s+rationale: isDecrease[\r\n]+\s+\? `Cap decrease)/
          if (!re.test(content)) throw new Error('sizePct_cap_change pattern not found')
          return content.replace(re, `$1${v}$3`)
        },
        read(content) {
          const m = content.match(/sizePct:\s*(\d+),[\r\n]+\s+urgency: 'medium',[\r\n]+\s+rationale: isDecrease[\r\n]+\s+\? `Cap decrease/)
          return m ? parseInt(m[1]) : null
        },
      },
      {
        id: 'sizePct_cross_protocol',
        name: 'sizePct cross-protocol indirect short',
        file: 'signalGenerator',
        current: 4,
        values: [2, 3, 4, 5],
        // Anchor: unique comment "// Lower conviction — indirect signal via cross-protocol mention"
        apply(content, v) {
          const re = /(sizePct:\s*)(\d+)(,\s*\/\/ Lower conviction — indirect signal via cross-protocol mention)/
          if (!re.test(content)) throw new Error('sizePct_cross_protocol pattern not found')
          return content.replace(re, `$1${v}$3`)
        },
        read(content) {
          const m = content.match(/sizePct:\s*(\d+),\s*\/\/ Lower conviction — indirect signal via cross-protocol mention/)
          return m ? parseInt(m[1]) : null
        },
      },
    ],
  },

  // ─── GROUP B: Liquidity leverage caps ──────────────────────────────────
  {
    name: 'B',
    label: 'Leverage caps (LIQUIDITY_LEV_CAP)',
    params: [
      {
        id: 'levcap_AAVE',
        name: 'AAVE leverage cap',
        file: 'signalGenerator',
        current: 7,
        values: [5, 6, 7, 8, 9],
        apply(content, v) {
          // "AAVE: 7, LINK: 7, UNI: 7, ARB: 7, OP: 7,"
          const re = /(AAVE:\s*)(\d+)(,\s*\/?\/?.*LINK)/
          if (!re.test(content)) throw new Error('levcap_AAVE pattern not found')
          return content.replace(re, `$1${v}$3`)
        },
        read(content) {
          const m = content.match(/AAVE:\s*(\d+),/)
          return m ? parseInt(m[1]) : null
        },
      },
      {
        id: 'levcap_ARB',
        name: 'ARB leverage cap',
        file: 'signalGenerator',
        current: 7,
        values: [5, 6, 7, 8, 9],
        apply(content, v) {
          // "AAVE: 7, LINK: 7, UNI: 7, ARB: 7, OP: 7,"
          const re = /(ARB:\s*)(\d+)(, OP:)/
          if (!re.test(content)) throw new Error('levcap_ARB pattern not found')
          return content.replace(re, `$1${v}$3`)
        },
        read(content) {
          const m = content.match(/ARB:\s*(\d+), OP:/)
          return m ? parseInt(m[1]) : null
        },
      },
      {
        id: 'levcap_DYDX',
        name: 'DYDX leverage cap',
        file: 'signalGenerator',
        current: 2,
        values: [1, 2, 3, 4],
        apply(content, v) {
          // "DYDX: 2, // $235 24h volume"
          const re = /(DYDX:\s*)(\d+)(,\s*\/\/.*24h volume — lower liquidity)/
          if (!re.test(content)) throw new Error('levcap_DYDX pattern not found')
          return content.replace(re, `$1${v}$3`)
        },
        read(content) {
          const m = content.match(/DYDX:\s*(\d+),\s*\/\/.*24h volume — lower liquidity/)
          return m ? parseInt(m[1]) : null
        },
      },
      {
        id: 'levcap_LDO',
        name: 'LDO leverage cap',
        file: 'signalGenerator',
        current: 3,
        values: [2, 3, 4, 5],
        apply(content, v) {
          // "SNX: 3, LDO: 3," — inline with SNX for uniqueness
          const re = /(SNX: \d+, LDO:\s*)(\d+)(,)/
          if (!re.test(content)) throw new Error('levcap_LDO pattern not found')
          return content.replace(re, `$1${v}$3`)
        },
        read(content) {
          const m = content.match(/SNX: \d+, LDO:\s*(\d+),/)
          return m ? parseInt(m[1]) : null
        },
      },
      {
        id: 'levcap_COMP',
        name: 'COMP leverage cap',
        file: 'signalGenerator',
        current: 5,
        values: [3, 4, 5, 6, 7],
        apply(content, v) {
          // "COMP: 5, // COMP has decent dYdX liquidity"
          const re = /(COMP:\s*)(\d+)(,\s*\/\/ COMP has decent)/
          if (!re.test(content)) throw new Error('levcap_COMP pattern not found')
          return content.replace(re, `$1${v}$3`)
        },
        read(content) {
          const m = content.match(/COMP:\s*(\d+),\s*\/\/ COMP has decent/)
          return m ? parseInt(m[1]) : null
        },
      },
      {
        id: 'levcap_CRV',
        name: 'CRV leverage cap',
        file: 'signalGenerator',
        current: 2,
        values: [1, 2, 3, 4],
        apply(content, v) {
          // "CRV: 2, WSTETH: 2, RETH: 2,"
          const re = /(CRV:\s*)(\d+)(, WSTETH:)/
          if (!re.test(content)) throw new Error('levcap_CRV pattern not found')
          return content.replace(re, `$1${v}$3`)
        },
        read(content) {
          const m = content.match(/CRV:\s*(\d+), WSTETH:/)
          return m ? parseInt(m[1]) : null
        },
      },
    ],
  },

  // ─── GROUP C: Risk timing ───────────────────────────────────────────────
  {
    name: 'C',
    label: 'Risk timing (SL / decay)',
    params: [
      {
        id: 'minHoldBeforeSL',
        name: 'Minimum hold before SL fires (hours)',
        file: 'resultCollector',
        current: 72,
        values: [36, 48, 60, 72, 84, 96],
        apply(content, v) {
          // "if (holdingHours >= 72 &&" — the SL condition guard
          const re = /(if \(holdingHours >= )(\d+)( && priceChangePct < -effectiveSL\))/
          if (!re.test(content)) throw new Error('minHoldBeforeSL pattern not found')
          return content.replace(re, `$1${v}$3`)
        },
        read(content) {
          const m = content.match(/if \(holdingHours >= (\d+) && priceChangePct < -effectiveSL\)/)
          return m ? parseInt(m[1]) : null
        },
      },
      {
        id: 'decayFloor',
        name: 'SL decay floor (fraction)',
        file: 'resultCollector',
        current: 0.65,
        values: [0.55, 0.60, 0.65, 0.70, 0.75],
        apply(content, v) {
          // "Math.max(0.65, decayFactor)"
          const re = /(Math\.max\()([\d.]+)(, decayFactor\))/
          if (!re.test(content)) throw new Error('decayFloor pattern not found')
          return content.replace(re, `$1${v}$3`)
        },
        read(content) {
          const m = content.match(/Math\.max\(([\d.]+), decayFactor\)/)
          return m ? parseFloat(m[1]) : null
        },
      },
      {
        id: 'decayStart',
        name: 'SL decay start (hours held)',
        file: 'resultCollector',
        current: 336,
        values: [240, 288, 336, 384, 432],
        apply(content, v) {
          // "holdingHours > 336)" in the decay condition
          const re = /(priceChangePct < 0 && holdingHours > )(\d+)(\))/
          if (!re.test(content)) throw new Error('decayStart pattern not found (condition)')
          let updated = content.replace(re, `$1${v}$3`)
          // Also update the Math.min decay calc: "(holdingHours - 336) / 168"
          const re2 = /(\(holdingHours - )(\d+)(\) \/ 168)/
          if (!re2.test(updated)) throw new Error('decayStart pattern not found (calc)')
          updated = updated.replace(re2, `$1${v}$3`)
          return updated
        },
        read(content) {
          const m = content.match(/priceChangePct < 0 && holdingHours > (\d+)\)/)
          return m ? parseInt(m[1]) : null
        },
      },
      {
        id: 'maxAbsLoss',
        name: 'Max absolute loss fraction',
        file: 'resultCollector',
        current: 0.10,
        values: [0.07, 0.08, 0.09, 0.10, 0.11, 0.12],
        apply(content, v) {
          // "const maxAbsLoss = this.initialPortfolio * 0.10"
          const re = /(const maxAbsLoss = this\.initialPortfolio \* )([\d.]+)/
          if (!re.test(content)) throw new Error('maxAbsLoss pattern not found')
          return content.replace(re, `$1${v}`)
        },
        read(content) {
          const m = content.match(/const maxAbsLoss = this\.initialPortfolio \* ([\d.]+)/)
          return m ? parseFloat(m[1]) : null
        },
      },
    ],
  },

  // ─── GROUP D: Momentum thresholds ──────────────────────────────────────
  {
    name: 'D',
    label: 'Momentum thresholds',
    params: [
      {
        id: 'mom14d_threshold',
        name: 'A3 14d downtrend block threshold',
        file: 'signalGenerator',
        current: -0.08,
        values: [-0.12, -0.10, -0.08, -0.06, -0.04],
        apply(content, v) {
          // Three occurrences: dynamic asset, dynamic ETH macro, legacy path
          // All use pattern: "< -0.08" anchored to mom14d/ethMom14d checks
          const vStr = String(v)  // "-0.08" etc.
          // Replace all "< -0.08" patterns in the A3/B2 momentum checks
          // Use the unique surrounding identifiers to be safe
          const patterns = [
            // Dynamic path: asset check
            /(mom14d_a3 !== null && mom14d_a3 < )([-\d.]+)/,
            // Dynamic path: ETH macro check
            /(ethMom14d_a3 !== null && ethMom14d_a3 < )([-\d.]+)/,
            // Legacy path: asset check
            /(mom14dLeg !== null && mom14dLeg < )([-\d.]+)/,
          ]
          let updated = content
          for (const re of patterns) {
            if (!re.test(updated)) throw new Error(`mom14d_threshold pattern not found: ${re}`)
            updated = updated.replace(re, `$1${vStr}`)
          }
          return updated
        },
        read(content) {
          const m = content.match(/mom14d_a3 !== null && mom14d_a3 < ([-\d.]+)/)
          return m ? parseFloat(m[1]) : null
        },
      },
      {
        id: 'mom3d_threshold',
        name: 'A3 3d downtrend block threshold',
        file: 'signalGenerator',
        current: -0.04,
        values: [-0.06, -0.05, -0.04, -0.03, -0.02],
        apply(content, v) {
          const vStr = String(v)
          const re = /(mom3d_a3 !== null && mom3d_a3 < )([-\d.]+)/
          if (!re.test(content)) throw new Error('mom3d_threshold pattern not found')
          return content.replace(re, `$1${vStr}`)
        },
        read(content) {
          const m = content.match(/mom3d_a3 !== null && mom3d_a3 < ([-\d.]+)/)
          return m ? parseFloat(m[1]) : null
        },
      },
      {
        id: 'exhausted_move_cap',
        name: 'Exhausted move 7d cap',
        file: 'signalGenerator',
        current: 0.15,
        values: [0.10, 0.12, 0.15, 0.18, 0.20],
        apply(content, v) {
          // Two occurrences: "moveInTradeDir > 0.15" and ETH check "ethMom14d !== null && ethMom14d > 0.15)"
          const vStr = String(v)
          // Pattern 1: move in trade direction (exhausted momentum check)
          const re1 = /(moveInTradeDir > )([\d.]+)/
          if (!re1.test(content)) throw new Error('exhausted_move_cap pattern 1 (moveInTradeDir) not found')
          let updated = content.replace(re1, `$1${vStr}`)
          // Pattern 2: ETH macro exhaustion — anchored by "ethMom14d !== null && ethMom14d >"
          const re2 = /(ethMom14d !== null && ethMom14d > )([\d.]+)(\) \{)/
          if (!re2.test(updated)) throw new Error('exhausted_move_cap pattern 2 (ethMom14d) not found')
          updated = updated.replace(re2, `$1${vStr}$3`)
          return updated
        },
        read(content) {
          const m = content.match(/moveInTradeDir > ([\d.]+)/)
          return m ? parseFloat(m[1]) : null
        },
      },
    ],
  },

  // ─── GROUP E: Portfolio heat cap ────────────────────────────────────────
  {
    name: 'E',
    label: 'Portfolio heat cap',
    params: [
      {
        id: 'heat_cap',
        name: 'Max open positions (heat cap)',
        file: 'signalGenerator',
        current: 10,
        values: [6, 7, 8, 9, 10, 11, 12],
        apply(content, v) {
          // "if (currentPositions.length >= 10) {"
          const re = /(if \(currentPositions\.length >= )(\d+)(\) \{)/
          if (!re.test(content)) throw new Error('heat_cap pattern not found')
          return content.replace(re, `$1${v}$3`)
        },
        read(content) {
          const m = content.match(/if \(currentPositions\.length >= (\d+)\) \{/)
          return m ? parseInt(m[1]) : null
        },
      },
    ],
  },
]

// ═══════════════════════════════════════════════════════════════════════════
// APPLY / RESTORE helpers
// ═══════════════════════════════════════════════════════════════════════════

function readFile(fileKey) {
  return readFileSync(FILES[fileKey], 'utf-8')
}

function writeFile(fileKey, content) {
  writeFileSync(FILES[fileKey], content, 'utf-8')
}

// Snapshot of file contents before a group starts (for group-level revert)
const groupSnapshots = {}

function snapshotGroup(group) {
  const fileKeys = [...new Set(group.params.map(p => p.file))]
  groupSnapshots[group.name] = {}
  for (const fk of fileKeys) {
    groupSnapshots[group.name][fk] = readFile(fk)
  }
}

function revertGroup(group) {
  for (const [fk, content] of Object.entries(groupSnapshots[group.name] ?? {})) {
    writeFile(fk, content)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═'.repeat(70))
  console.log('  DeFi Bot — Exhaustive Parameter Grid Sweep')
  console.log('═'.repeat(70))
  if (DRY_RUN) console.log('  ⚡ DRY-RUN mode — no backtests will run')
  if (ONLY_GROUP) console.log(`  ⚡ Only running group: ${ONLY_GROUP}`)
  if (SKIP_WFO)  console.log('  ⚠  WFO gate DISABLED')
  console.log()

  // ── Establish baseline ──────────────────────────────────────────────────
  if (!existsSync(REPORT_PATH)) {
    console.error('✗ No backtest report found. Run full-period backtest first.')
    process.exit(1)
  }

  const baselineMetrics = readReport()
  const baselineScore   = compositeScore(baselineMetrics)

  console.log('Baseline (full-period Jan 2025 – Feb 2026):')
  console.log(`  Trades: ${baselineMetrics.executedTrades}  WR: ${baselineMetrics.winRate.toFixed(1)}%  ` +
              `PF: ${baselineMetrics.profitFactor.toFixed(2)}  ` +
              `PnL: $${fmt(baselineMetrics.totalPnl)}  ` +
              `MaxDD: ${baselineMetrics.maxDrawdownPct.toFixed(1)}%  ` +
              `Score: ${baselineScore}/100`)
  console.log()

  const improvements = []

  for (const group of PARAM_GROUPS) {
    if (ONLY_GROUP && group.name !== ONLY_GROUP) continue

    console.log('─'.repeat(70))
    console.log(`GROUP ${group.name}: ${group.label}  (${group.params.length} params)`)
    console.log('─'.repeat(70))

    // Snapshot file state before group starts (for group-level WFO revert)
    snapshotGroup(group)

    // Track current score as we sweep params within the group
    let currentScore = baselineScore
    const groupImprovements = []

    for (const param of group.params) {
      // Read current value from file
      const fileContent = readFile(param.file)
      const currentVal = param.read(fileContent)
      if (currentVal === null) {
        console.log(`  ⚠  [${param.id}] Could not read current value — skipping`)
        continue
      }

      console.log(`\n  → ${param.name} (current: ${currentVal})`)

      let bestVal   = currentVal
      let bestScore = currentScore

      for (const candVal of param.values) {
        if (candVal === currentVal) continue  // skip unchanged

        if (DRY_RUN) {
          console.log(`     [DRY] would try: ${candVal}`)
          continue
        }

        // Apply candidate value
        let newContent
        try {
          newContent = param.apply(readFile(param.file), candVal)
        } catch (err) {
          console.log(`     [${candVal}] ✗ Apply failed: ${err.message}`)
          continue
        }
        writeFile(param.file, newContent)

        // Run backtest
        const bt = runBacktest()
        if (!bt.success) {
          console.log(`     [${candVal}] ✗ Backtest failed — reverting`)
          // Restore to current best
          const restoreContent = param.apply(readFile(param.file), bestVal)
          writeFile(param.file, restoreContent)
          continue
        }

        const trialMetrics = readReport()
        const trialScore   = compositeScore(trialMetrics)

        const indicator = trialScore > bestScore ? '✓' : trialScore === bestScore ? '~' : '✗'
        console.log(
          `     [${candVal}] ${indicator} Score: ${trialScore}  ` +
          `WR: ${trialMetrics.winRate.toFixed(1)}%  ` +
          `PnL: $${fmt(trialMetrics.totalPnl)}  ` +
          `Trades: ${trialMetrics.executedTrades}  ` +
          `PF: ${trialMetrics.profitFactor.toFixed(2)}`
        )

        if (trialScore > bestScore) {
          bestVal   = candVal
          bestScore = trialScore
        }

        // Restore after trial (always restore to run next candidate cleanly)
        const restoreContent = param.apply(readFile(param.file), bestVal)
        writeFile(param.file, restoreContent)
      }

      if (DRY_RUN) continue

      if (bestVal !== currentVal) {
        // Apply best permanently
        const bestContent = param.apply(readFile(param.file), bestVal)
        writeFile(param.file, bestContent)
        currentScore = bestScore
        const delta = bestScore - baselineScore
        console.log(`  ✓ ${param.name}: ${currentVal} → ${bestVal}  (score +${delta.toFixed(1)} vs baseline)`)
        groupImprovements.push({ param: param.id, from: currentVal, to: bestVal, scoreDelta: delta })
      } else {
        console.log(`  = ${param.name}: ${currentVal} unchanged (already optimal)`)
      }
    }

    if (DRY_RUN) continue

    // ── WFO gate after group ─────────────────────────────────────────────
    if (groupImprovements.length === 0) {
      console.log(`\n  GROUP ${group.name}: no changes — skipping WFO gate`)
      continue
    }

    if (SKIP_WFO) {
      console.log(`\n  GROUP ${group.name}: WFO gate skipped`)
      improvements.push(...groupImprovements)
      continue
    }

    console.log(`\n  Running WFO gate for group ${group.name}...`)
    const wfo = runWfoCheck()
    const wfoOk = wfo.wfoProfitable >= 11 && wfo.robustness >= 97.0

    console.log(
      `  WFO: ${wfo.wfoProfitable}/${wfo.wfoTotal} profitable  ` +
      `Robustness: ${wfo.robustness.toFixed(1)}%  ` +
      `${wfoOk ? '✓ PASS' : '✗ FAIL'}`
    )

    if (!wfoOk) {
      console.log(`  ⚠  GROUP ${group.name} REVERTED — WFO gate failed`)
      revertGroup(group)
      // Re-run baseline backtest to restore report
      runBacktest()
    } else {
      console.log(`  ✓ GROUP ${group.name} accepted`)
      improvements.push(...groupImprovements)
    }
  }

  // ── Final summary ────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70))
  console.log('  FINAL SUMMARY')
  console.log('═'.repeat(70))

  if (improvements.length === 0) {
    console.log('  No improvements found — baseline is optimal.')
  } else {
    console.log(`  ${improvements.length} parameters improved:`)
    for (const imp of improvements) {
      console.log(`    ${imp.param}: ${imp.from} → ${imp.to}  (score Δ${imp.scoreDelta > 0 ? '+' : ''}${imp.scoreDelta.toFixed(1)})`)
    }
  }

  if (!DRY_RUN) {
    // Final backtest to get updated report
    console.log('\n  Running final full-period backtest...')
    runBacktest()
    const finalMetrics = readReport()
    const finalScore   = compositeScore(finalMetrics)
    console.log(`\n  Final results:`)
    console.log(`    Trades: ${finalMetrics.executedTrades}  WR: ${finalMetrics.winRate.toFixed(1)}%  ` +
                `PF: ${finalMetrics.profitFactor.toFixed(2)}  ` +
                `PnL: $${fmt(finalMetrics.totalPnl)}  ` +
                `MaxDD: ${finalMetrics.maxDrawdownPct.toFixed(1)}%  ` +
                `Score: ${finalScore}/100`)
    console.log(`    vs Baseline: score ${baselineScore} → ${finalScore} ` +
                `(Δ${finalScore >= baselineScore ? '+' : ''}${(finalScore - baselineScore).toFixed(1)})`)
  }

  console.log()
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
