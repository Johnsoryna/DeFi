#!/usr/bin/env node
/**
 * OODA Meta-Loop: Observe → Orient → Decide → Act
 * ═══════════════════════════════════════════════════════════════════════════
 * Autonomous strategy parameter optimizer for the DeFi governance bot.
 * Uses the OODA decision cycle to iteratively improve backtest performance.
 *
 * Scoring rubric (0–100 composite):
 *   Win Rate      30% — target ≥82%
 *   PnL           30% — target ≥$120K for the active window
 *   Max Drawdown  20% — target ≤15% (lower is better)
 *   Trade Count   10% — optimal band 25–40
 *   Profit Factor 10% — target ≥3.5
 *
 * Usage:
 *   node scripts/ooda-loop.mjs                            # 1 iteration, 6-month window
 *   node scripts/ooda-loop.mjs --iterations 3             # 3 sequential iterations
 *   node scripts/ooda-loop.mjs --full-period              # use 13-month window (Jan25–Feb26)
 *   node scripts/ooda-loop.mjs --dry-run                  # plan only, no backtests
 *   node scripts/ooda-loop.mjs --score-only               # score current state, exit
 *   node scripts/ooda-loop.mjs --full-period --iterations 3  # full-period, 3 iterations
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const REPORT_PATH = join(ROOT, 'data', 'backtest-report.json')
const PROMPT_GEN = join(ROOT, 'prompt_gen.md')

// ─── CLI flags ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const DRY_RUN    = args.includes('--dry-run')
const SCORE_ONLY = args.includes('--score-only')
const ITERATIONS = (() => {
  const idx = args.indexOf('--iterations')
  return idx !== -1 ? parseInt(args[idx + 1], 10) : 1
})()
const VERBOSE     = args.includes('--verbose')
const FULL_PERIOD = args.includes('--full-period')  // --from 2025-01-01 --to 2026-02-20

// ─── File paths for key strategy files ────────────────────────────────────
const FILES = {
  signalGenerator:  join(ROOT, 'src', 'strategy', 'signalGenerator.ts'),
  confidenceScorer: join(ROOT, 'src', 'strategy', 'confidenceScorer.ts'),
  riskManager:      join(ROOT, 'src', 'strategy', 'riskManager.ts'),
}

// ═══════════════════════════════════════════════════════════════════════════
// SCORING RUBRIC
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Score a set of backtest metrics into a 0–100 composite.
 * Each sub-metric is clamped to [0,100] then weighted.
 *
 * @param {object} m - Metrics from backtest-report.json
 * @returns {{ score: number, breakdown: object }}
 */
function scoreMetrics(m) {
  const {
    winRate = 0,
    totalPnl = 0,
    maxDrawdownPct = 0,
    executedTrades = 0,
    profitFactor = 0,
  } = m

  // ── Win Rate (30%) ──────────────────────────────────────────────────────
  // 0% WR → 0pts, 65% → 50pts, 82% → 100pts (linear between thresholds)
  const wrScore = winRate >= 82 ? 100
    : winRate >= 65 ? lerp(50, 100, (winRate - 65) / 17)
    : lerp(0, 50, winRate / 65)

  // ── PnL (30%) ───────────────────────────────────────────────────────────
  // $0 → 0pts, $80K → 50pts, $120K → 100pts
  const pnlScore = totalPnl >= 120_000 ? 100
    : totalPnl >= 80_000 ? lerp(50, 100, (totalPnl - 80_000) / 40_000)
    : totalPnl > 0 ? lerp(0, 50, totalPnl / 80_000)
    : 0

  // ── Max Drawdown (20%) ──────────────────────────────────────────────────
  // ≤10% → 100pts, 15% → 75pts, 25% → 40pts, ≥35% → 0pts
  const ddScore = maxDrawdownPct <= 10 ? 100
    : maxDrawdownPct <= 15 ? lerp(75, 100, (15 - maxDrawdownPct) / 5)
    : maxDrawdownPct <= 25 ? lerp(40, 75, (25 - maxDrawdownPct) / 10)
    : maxDrawdownPct <= 35 ? lerp(0, 40, (35 - maxDrawdownPct) / 10)
    : 0

  // ── Trade Count (10%) ───────────────────────────────────────────────────
  // Optimal band 25–40 → 100pts; penalised outside
  const tcScore = executedTrades >= 25 && executedTrades <= 40 ? 100
    : executedTrades >= 15 && executedTrades < 25 ? lerp(40, 100, (executedTrades - 15) / 10)
    : executedTrades > 40 && executedTrades <= 55 ? lerp(60, 100, (55 - executedTrades) / 15)
    : executedTrades > 55 ? 20   // too many → noise
    : 10                          // <15 → too few

  // ── Profit Factor (10%) ─────────────────────────────────────────────────
  // 1.0 → 0pts, 2.0 → 50pts, 3.5 → 100pts
  const pfCapped = Math.min(profitFactor, 10)
  const pfScore = pfCapped >= 3.5 ? 100
    : pfCapped >= 2.0 ? lerp(50, 100, (pfCapped - 2.0) / 1.5)
    : pfCapped >= 1.0 ? lerp(0, 50, (pfCapped - 1.0) / 1.0)
    : 0

  const composite = wrScore * 0.30 + pnlScore * 0.30 + ddScore * 0.20
    + tcScore * 0.10 + pfScore * 0.10

  return {
    score: Math.round(composite * 10) / 10,
    breakdown: {
      winRate:    { raw: winRate.toFixed(2) + '%',     score: Math.round(wrScore)  },
      pnl:        { raw: '$' + fmt(totalPnl),          score: Math.round(pnlScore) },
      drawdown:   { raw: maxDrawdownPct.toFixed(2)+'%',score: Math.round(ddScore)  },
      tradeCount: { raw: executedTrades,               score: Math.round(tcScore)  },
      profitFactor:{ raw: profitFactor.toFixed(2),     score: Math.round(pfScore)  },
    },
  }
}

function lerp(a, b, t) { return a + (b - a) * Math.max(0, Math.min(1, t)) }
function fmt(n) { return n.toLocaleString('en-US', { maximumFractionDigits: 0 }) }

// ═══════════════════════════════════════════════════════════════════════════
// OBSERVE: read current state
// ═══════════════════════════════════════════════════════════════════════════

function observe() {
  if (!existsSync(REPORT_PATH)) {
    throw new Error(`No backtest report found at ${REPORT_PATH}. Run backtest first.`)
  }
  const raw = JSON.parse(readFileSync(REPORT_PATH, 'utf-8'))
  const s = raw.summary   || {}
  const p = raw.performance || {}
  return {
    startDate:       s.startDate,
    endDate:         s.endDate,
    winRate:         p.winRate          ?? 0,
    totalPnl:        s.totalPnl         ?? 0,
    totalPnlPct:     s.totalPnlPct      ?? 0,
    maxDrawdownPct:  p.maxDrawdownPct   ?? 0,
    executedTrades:  s.executedTrades   ?? 0,
    profitFactor:    p.profitFactor     ?? 0,
    sharpeRatio:     p.sharpeRatio      ?? 0,
    avgHoldingHours: p.avgHoldingPeriodHours ?? 0,
    eventsReplayed:  s.eventsReplayed   ?? 0,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ORIENT: read current parameter values from source files
// ═══════════════════════════════════════════════════════════════════════════

function orient() {
  const sg = readFileSync(FILES.signalGenerator,  'utf-8')
  const cs = readFileSync(FILES.confidenceScorer, 'utf-8')

  const params = {}

  // STAGE_MIN_CONFIDENCE block
  // Store both numeric value and raw string for round-trip regex safety
  const stageBlock = sg.match(/STAGE_MIN_CONFIDENCE[^{]+\{([^}]+)\}/)
  if (!stageBlock) {
    if (VERBOSE) console.warn('  ⚠ orient(): STAGE_MIN_CONFIDENCE block not found in signalGenerator.ts')
  } else {
    for (const [, key, val] of stageBlock[1].matchAll(/(\w+):\s*([\d.]+)/g)) {
      params[`stage_${key}`] = { value: parseFloat(val), raw: val, file: 'signalGenerator', key }
    }
  }

  // MORPHO threshold
  const morpho = sg.match(/WEAK_ALPHA_PROTOCOLS.*?return\s*([\d.]+)/s)
  if (morpho) params['morpho_threshold'] = { value: parseFloat(morpho[1]), raw: morpho[1], file: 'signalGenerator' }

  // Trailing stop — parse by profile block name, NOT by comment text.
  // This is immune to comment changes (e.g. "12%" → "14%" after a mutation).
  for (const profileKey of ['aggressive', 'moderate']) {
    // Extract the profile block: "profileKey: { ... }" (no nested braces in these objects)
    const blockM = cs.match(new RegExp(`${profileKey}:\\s*\\{([^}]+)\\}`))
    if (!blockM) continue
    const block = blockM[1]
    const act  = block.match(/trailingStopActivation:\s*(0\.\d+)/)
    const dist = block.match(/trailingStopDistance:\s*(0\.\d+)/)
    if (act)  params[`trailingAct_${profileKey}`]  = { value: parseFloat(act[1]),  raw: act[1],  file: 'confidenceScorer', profileKey }
    if (dist) params[`trailingDist_${profileKey}`] = { value: parseFloat(dist[1]), raw: dist[1], file: 'confidenceScorer', profileKey }
  }

  // maxSizePct
  const maxSize = cs.match(/maxSizePct:\s*(\d+),/)
  if (maxSize) params['maxSizePct'] = { value: parseInt(maxSize[1], 10), raw: maxSize[1], file: 'confidenceScorer' }

  // Long threshold offset (+0.10) — raw preserves trailing zero (0.10 not 0.1)
  const longOffset = sg.match(/minConfidence \+ (0\.\d+)\s*\/\/ Longs/)
  if (longOffset) params['long_threshold_offset'] = { value: parseFloat(longOffset[1]), raw: longOffset[1], file: 'signalGenerator' }

  return params
}

// ═══════════════════════════════════════════════════════════════════════════
// DECIDE: generate ranked candidate mutations
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Each mutation is: { id, param, delta, rationale, priority, risk }
 * priority: 1=highest, 5=lowest
 * risk: 'low' | 'medium' | 'high'
 */
function decide(metrics, params, previousTried = []) {
  const { winRate, maxDrawdownPct, executedTrades, profitFactor } = metrics
  const candidates = []

  const alreadyTried = new Set(previousTried.map(t => t.id))

  // ── Candidate pool ────────────────────────────────────────────────────
  const pool = [
    // Tighten discussion threshold → filter lower-quality forum posts
    {
      id: 'discussion_threshold_up',
      param: 'stage_discussion',
      delta: +0.02,
      rationale: 'Raise discussion min-confidence 0.50→0.52 to filter marginal forum signals',
      priority: 2, risk: 'low',
      condition: () => winRate < 80 || profitFactor < 3.0,
    },
    // Loosen discussion threshold → catch more quality signals
    {
      id: 'discussion_threshold_down',
      param: 'stage_discussion',
      delta: -0.02,
      rationale: 'Lower discussion min-confidence 0.50→0.48 to capture near-threshold signals',
      priority: 4, risk: 'medium',
      condition: () => executedTrades < 28,
    },
    // Tighten snapshot threshold
    {
      id: 'snapshot_threshold_up',
      param: 'stage_snapshot',
      delta: +0.02,
      rationale: 'Raise snapshot min-confidence 0.55→0.57 to filter speculative snapshot signals',
      priority: 2, risk: 'low',
      condition: () => winRate < 78,
    },
    // Loosen snapshot threshold
    {
      id: 'snapshot_threshold_down',
      param: 'stage_snapshot',
      delta: -0.02,
      rationale: 'Lower snapshot min-confidence 0.55→0.53 to expand snapshot trade set',
      priority: 4, risk: 'medium',
      condition: () => executedTrades < 25,
    },
    // Wider trailing stop activation (aggressive) — let profits develop
    {
      id: 'trailing_act_agg_up',
      param: 'trailingAct_aggressive',
      delta: +0.02,
      rationale: 'Raise aggressive trailing activation — lock in bigger wins before trailing fires',
      priority: 2, risk: 'medium',
      // Safe range: result must not exceed 0.22
      condition: () => ((params['trailingAct_aggressive']?.value ?? 0) + 0.02) <= 0.22,
    },
    // Tighter trailing stop activation (aggressive) — lock gains earlier
    {
      id: 'trailing_act_agg_down',
      param: 'trailingAct_aggressive',
      delta: -0.02,
      rationale: 'Lower aggressive trailing activation — activate trailing sooner, reduce retracement',
      priority: 3, risk: 'medium',
      // Safe range: result must not go below 0.08
      condition: () => maxDrawdownPct > 20 && ((params['trailingAct_aggressive']?.value ?? 1) - 0.02) >= 0.08,
    },
    // Wider trailing stop distance (aggressive) — give more room to breathe
    {
      id: 'trailing_dist_agg_up',
      param: 'trailingDist_aggressive',
      delta: +0.01,
      rationale: 'Widen aggressive trailing distance — governance positions need room to develop',
      priority: 3, risk: 'low',
      // Safe range: result must not exceed 0.10; only when PF is low
      condition: () => winRate > 78 && profitFactor < 4.0 && ((params['trailingDist_aggressive']?.value ?? 0) + 0.01) <= 0.10,
    },
    // Tighter trailing stop distance (aggressive) — lock profits faster
    {
      id: 'trailing_dist_agg_down',
      param: 'trailingDist_aggressive',
      delta: -0.01,
      rationale: 'Tighten aggressive trailing distance — reduce P&L retracement on exit',
      priority: 3, risk: 'low',
      // Safe range: result must not go below 0.04
      condition: () => maxDrawdownPct > 18 && ((params['trailingDist_aggressive']?.value ?? 1) - 0.01) >= 0.04,
    },
    // Moderate trailing stop activation up
    {
      id: 'trailing_act_mod_up',
      param: 'trailingAct_moderate',
      delta: +0.02,
      rationale: 'Raise moderate trailing activation — let moderate positions run further before locking',
      priority: 3, risk: 'low',
      // Safe range: result must not exceed 0.18
      condition: () => ((params['trailingAct_moderate']?.value ?? 0) + 0.02) <= 0.18,
    },
    // Long threshold offset up — require higher conviction for longs
    {
      id: 'long_offset_up',
      param: 'long_threshold_offset',
      delta: +0.05,
      rationale: 'Increase long threshold offset — longs have weak alpha, require higher conviction',
      priority: 1, risk: 'low',
      // Safe range: result must not exceed 0.18; only when WR below target
      condition: () => winRate < 82 && ((params['long_threshold_offset']?.value ?? 0) + 0.05) <= 0.18,
    },
    // maxSizePct down — reduce concentration risk
    {
      id: 'max_size_down',
      param: 'maxSizePct',
      delta: -1,
      rationale: 'Reduce maxSizePct to lower max per-position loss exposure',
      priority: 4, risk: 'low',
      // Safe range: result must not go below 8%
      condition: () => maxDrawdownPct > 22 && ((params['maxSizePct']?.value ?? 99) - 1) >= 8,
    },
    // maxSizePct up — allow larger positions on high-confidence signals
    {
      id: 'max_size_up',
      param: 'maxSizePct',
      delta: +1,
      rationale: 'Raise maxSizePct to size up on best opportunities',
      priority: 4, risk: 'medium',
      // Safe range: result must not exceed 15%
      condition: () => winRate > 82 && executedTrades < 35 && ((params['maxSizePct']?.value ?? 99) + 1) <= 15,
    },
  ]

  for (const c of pool) {
    if (alreadyTried.has(c.id)) continue          // skip already-tried
    if (!c.condition()) continue                   // skip if not applicable
    if (!params[c.param]) continue                 // skip if param not parsed
    candidates.push({ ...c, currentValue: params[c.param].value })
  }

  // Sort by priority ASC, then risk ASC (low < medium < high)
  const riskOrder = { low: 0, medium: 1, high: 2 }
  candidates.sort((a, b) =>
    a.priority !== b.priority
      ? a.priority - b.priority
      : riskOrder[a.risk] - riskOrder[b.risk]
  )

  return candidates
}

// ═══════════════════════════════════════════════════════════════════════════
// ACT: apply mutation, run backtest, restore if worse
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Replace a field's value ONLY within a named profile block (e.g. "moderate: { ... }").
 * Profile objects have no nested braces, so [^}]+ safely captures the whole body.
 * Returns the updated content string, or null if the block/field was not found.
 */
function replaceInProfileBlock(content, profileKey, fieldKey, oldVal, newVal) {
  // Capture: before-block | "profileKey: {" | block-body | "}" | after-block
  const blockRe = new RegExp(`(${profileKey}:\\s*\\{)([^}]+)(\\})`)
  const m = content.match(blockRe)
  if (!m) return null
  const fieldRe = new RegExp(`(${fieldKey}:\\s*)(${escRe(oldVal)})`)
  if (!fieldRe.test(m[2])) return null
  const newBody = m[2].replace(fieldRe, `$1${newVal}`)
  return content.replace(blockRe, `$1${newBody}$3`)
}

function applyMutation(mutation, params) {
  const { param, delta } = mutation
  const info = params[param]
  const newValue = Math.round((info.value + delta) * 1000) / 1000

  const filePath = FILES[info.file === 'signalGenerator' ? 'signalGenerator'
    : info.file === 'confidenceScorer' ? 'confidenceScorer' : 'riskManager']

  let content = readFileSync(filePath, 'utf-8')
  // Use raw (original string from file) for matching — preserves trailing zeros (0.10 ≠ 0.1)
  const oldStr = info.raw ?? info.value.toString()
  const newStr = newValue.toString()

  let replaced = false

  if (param.startsWith('stage_')) {
    // Anchor on stage key name, then match any numeric value after colon
    const stageKey = info.key
    const re = new RegExp(`(${stageKey}:\\s*)(${escRe(oldStr)})`)
    if (re.test(content)) {
      content = content.replace(re, `$1${newStr}`)
      replaced = true
    }
  } else if (param === 'trailingAct_moderate' || param === 'trailingDist_moderate' ||
             param === 'trailingAct_aggressive' || param === 'trailingDist_aggressive') {
    // Replace ONLY within the specific profile block — immune to comment text changes.
    const profileKey = info.profileKey  // 'moderate' | 'aggressive'
    const fieldKey   = param.startsWith('trailingAct_') ? 'trailingStopActivation' : 'trailingStopDistance'
    const result = replaceInProfileBlock(content, profileKey, fieldKey, oldStr, newStr)
    if (result !== null) { content = result; replaced = true }
  } else if (param === 'maxSizePct') {
    const re = /(maxSizePct:\s*)(\d+)(,\s*\/\/ Max)/
    if (re.test(content)) { content = content.replace(re, `$1${newStr}$3`); replaced = true }
  } else if (param === 'long_threshold_offset') {
    // Anchor on surrounding context — raw value from file handles trailing zeros
    const re = new RegExp(`(minConfidence \\+ )(${escRe(oldStr)})(\\s*\\/\\/ Longs)`)
    if (re.test(content)) { content = content.replace(re, `$1${newStr}$3`); replaced = true }
  }

  if (!replaced) {
    return { success: false, error: `Could not locate ${param} = "${oldStr}" in ${info.file}.ts` }
  }

  writeFileSync(filePath, content, 'utf-8')
  return { success: true, filePath, param, oldValue: info.value, newValue }
}

function revertMutation(mutation) {
  // Re-orient from current file state to get the post-mutation raw value, then reverse
  const freshParams = orient()
  const reversed = { ...mutation, delta: -mutation.delta }
  applyMutation(reversed, freshParams)
}

function escRe(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function runBacktest() {
  const dateFlags = FULL_PERIOD
    ? '--from 2025-01-01 --to 2026-02-20'
    : ''  // default: 6-month dynamic window
  const cmd = `npx tsx src/backtest/index.ts run ${dateFlags}`.trim()
  const t0 = Date.now()
  try {
    if (VERBOSE) console.log(`  ▶ Running backtest: ${cmd}`)
    // 'pipe' causes ENOBUFS on large DEBUG output (~2MB). Use 'inherit' for verbose,
    // 'ignore' otherwise — we only need the exit code; results come from the JSON report.
    execSync(cmd, { cwd: ROOT, stdio: VERBOSE ? 'inherit' : 'ignore', timeout: 600_000 })
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    if (VERBOSE) console.log(`  ✓ Backtest completed in ${elapsed}s`)
    return { success: true, elapsed }
  } catch (e) {
    return { success: false, error: e.message.slice(0, 200) }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LOG: append OODA iteration to prompt_gen.md
// ═══════════════════════════════════════════════════════════════════════════

function logIteration(data) {
  const {
    iteration, timestamp, phase,
    baseMetrics, baseScore,
    candidates, chosen,
    mutationResult, newMetrics, newScore,
    accepted, gaps,
  } = data

  const ts = new Date(timestamp).toISOString().replace('T', ' ').slice(0, 16)
  const arrow = accepted ? '✅ ACCEPTED' : '❌ REJECTED'
  const delta = newScore !== undefined ? (newScore - baseScore).toFixed(1) : 'N/A'

  let block = `\n## Iteration ${iteration} — ${ts}\n\n`

  // ── OBSERVE ──────────────────────────────────────────────────────────
  block += `### OBSERVE — Current State\n`
  block += `| Metric | Value | Sub-Score |\n|--------|-------|----------|\n`
  for (const [k, v] of Object.entries(baseScore.breakdown)) {
    block += `| ${k} | ${v.raw} | ${v.score}/100 |\n`
  }
  block += `\n**Composite Score: ${baseScore.score}/100**\n`
  block += `> Period: ${baseMetrics.startDate?.slice(0,10)} → ${baseMetrics.endDate?.slice(0,10)}\n`
  block += `> Events replayed: ${baseMetrics.eventsReplayed?.toLocaleString()}\n\n`

  // ── ORIENT ───────────────────────────────────────────────────────────
  block += `### ORIENT — Gap Analysis\n`
  for (const g of gaps) block += `- ${g}\n`
  block += `\n`

  // ── DECIDE ───────────────────────────────────────────────────────────
  block += `### DECIDE — Candidate Mutations (ranked)\n`
  block += `| # | ID | Param | Delta | Priority | Risk | Condition Met |\n`
  block += `|---|-----|-------|-------|----------|------|---------------|\n`
  candidates.slice(0, 6).forEach((c, i) => {
    const sel = chosen && c.id === chosen.id ? '**→**' : ''
    block += `| ${sel}${i+1} | ${c.id} | ${c.param} | ${c.delta > 0 ? '+' : ''}${c.delta} | ${c.priority} | ${c.risk} | ✓ |\n`
  })
  block += `\n`

  if (chosen) {
    block += `**Selected:** \`${chosen.id}\`  \n`
    block += `**Rationale:** ${chosen.rationale}  \n`
    const newVal = Math.round((chosen.currentValue + chosen.delta) * 1000) / 1000
    block += `**Change:** ${chosen.param} ${chosen.currentValue} → ${newVal}\n\n`
  } else {
    block += `**No candidates met conditions — baseline is optimal for current window.**\n\n`
  }

  if (phase === 'score-only' || DRY_RUN) {
    block += `> Mode: ${DRY_RUN ? 'DRY-RUN (no backtest executed)' : 'SCORE-ONLY'}\n\n`
    block += `---\n`
    return block
  }

  // ── ACT ──────────────────────────────────────────────────────────────
  block += `### ACT — Backtest Result\n`
  if (mutationResult && !mutationResult.success) {
    block += `> ⚠️ Mutation failed: ${mutationResult.error}\n\n`
  } else if (newMetrics && newScore) {
    block += `| Metric | Before | After | Δ |\n|--------|--------|-------|---|\n`
    const keys = ['winRate','totalPnl','maxDrawdownPct','executedTrades','profitFactor']
    const labels = ['Win Rate (%)','Total PnL ($)','Max Drawdown (%)','Trades','Profit Factor']
    keys.forEach((k, i) => {
      const before = baseMetrics[k]
      const after  = newMetrics[k]
      const d = typeof before === 'number' ? (after - before).toFixed(2) : '?'
      block += `| ${labels[i]} | ${fmt2(before)} | ${fmt2(after)} | ${d} |\n`
    })
    block += `\n**Score: ${baseScore.score} → ${newScore.score} (Δ ${delta})**  \n`
    block += `**Decision: ${arrow}**\n\n`
  }

  block += `---\n`
  return block
}

function fmt2(v) {
  if (typeof v !== 'number') return String(v)
  return v > 1000 ? '$' + Math.round(v).toLocaleString() : v.toFixed(2)
}

function appendToPromptGen(text) {
  const existing = existsSync(PROMPT_GEN) ? readFileSync(PROMPT_GEN, 'utf-8') : ''
  writeFileSync(PROMPT_GEN, existing + text, 'utf-8')
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════════════')
  console.log('  OODA Meta-Loop  —  DeFi Governance Bot Optimizer')
  console.log('═══════════════════════════════════════════════════════')
  const modeStr = DRY_RUN ? 'DRY-RUN' : SCORE_ONLY ? 'SCORE-ONLY' : 'LIVE'
  const windowStr = FULL_PERIOD ? 'Jan 2025–Feb 2026 (13mo)' : '6-month dynamic'
  console.log(`  Mode: ${modeStr}  |  Window: ${windowStr}  |  Iterations: ${ITERATIONS}`)
  console.log('═══════════════════════════════════════════════════════\n')

  // Track previously tried mutations across iterations
  const previousTried = []

  for (let iter = 1; iter <= ITERATIONS; iter++) {
    console.log(`\n┌─ ITERATION ${iter}/${ITERATIONS} ─────────────────────────────────┐`)

    // ── OBSERVE ──────────────────────────────────────────────────────────
    console.log('│ OBSERVE: Reading backtest report…')
    const baseMetrics = observe()
    const baseScore   = scoreMetrics(baseMetrics)

    console.log(`│  → Trades: ${baseMetrics.executedTrades}  |  PnL: $${fmt(baseMetrics.totalPnl)}`)
    console.log(`│  → WR: ${baseMetrics.winRate.toFixed(2)}%  |  MaxDD: ${baseMetrics.maxDrawdownPct.toFixed(2)}%`)
    console.log(`│  → Score: ${baseScore.score}/100`)

    if (SCORE_ONLY) {
      console.log('│ SCORE-ONLY mode — exiting after observe/orient.')
      const gaps = analyzeGaps(baseMetrics, baseScore)
      const params = orient()
      const candidates = decide(baseMetrics, params, previousTried)
      const logText = logIteration({
        iteration: iter, timestamp: Date.now(), phase: 'score-only',
        baseMetrics, baseScore, candidates, gaps,
        chosen: candidates[0] ?? null,
      })
      appendToPromptGen(logText)
      printScore(baseScore)
      break
    }

    // ── ORIENT ───────────────────────────────────────────────────────────
    console.log('│ ORIENT: Reading parameters, analysing gaps…')
    const params = orient()
    const gaps   = analyzeGaps(baseMetrics, baseScore)
    gaps.forEach(g => console.log(`│  ⚠ ${g}`))

    // ── DECIDE ───────────────────────────────────────────────────────────
    console.log('│ DECIDE: Ranking candidate mutations…')
    const candidates = decide(baseMetrics, params, previousTried)

    if (candidates.length === 0) {
      console.log('│  ✓ No improvement candidates found — baseline is optimal.')
      const logText = logIteration({
        iteration: iter, timestamp: Date.now(), phase: 'no-candidates',
        baseMetrics, baseScore, candidates: [], chosen: null, gaps,
      })
      appendToPromptGen(logText)
      break
    }

    const chosen = candidates[0]
    const chosenNewVal = Math.round((chosen.currentValue + chosen.delta) * 1000) / 1000
    console.log(`│  → Chose: "${chosen.id}" (${chosen.param} ${chosen.currentValue} → ${chosenNewVal})`)
    console.log(`│     ${chosen.rationale}`)

    if (DRY_RUN) {
      console.log('│ DRY-RUN: Skipping backtest execution.')
      const logText = logIteration({
        iteration: iter, timestamp: Date.now(), phase: 'dry-run',
        baseMetrics, baseScore, candidates, chosen, gaps,
      })
      appendToPromptGen(logText)
      previousTried.push(chosen)
      continue
    }

    // ── ACT ──────────────────────────────────────────────────────────────
    console.log('│ ACT: Applying mutation…')
    const mutationResult = applyMutation(chosen, params)

    if (!mutationResult.success) {
      console.log(`│  ✗ Mutation failed: ${mutationResult.error}`)
      previousTried.push(chosen)
      const logText = logIteration({
        iteration: iter, timestamp: Date.now(), phase: 'mutation-failed',
        baseMetrics, baseScore, candidates, chosen, mutationResult, gaps,
      })
      appendToPromptGen(logText)
      continue
    }

    console.log(`│  ✓ Applied: ${mutationResult.param} ${mutationResult.oldValue} → ${mutationResult.newValue}`)
    console.log('│ ACT: Running backtest…')
    const btResult = runBacktest()

    let newMetrics, newScore, accepted = false
    if (btResult.success) {
      newMetrics = observe()
      newScore   = scoreMetrics(newMetrics)
      accepted   = newScore.score > baseScore.score

      console.log(`│  Score: ${baseScore.score} → ${newScore.score} (Δ${(newScore.score - baseScore.score).toFixed(1)})`)
    } else {
      console.log(`│  ✗ Backtest failed: ${btResult.error}`)
    }

    if (!accepted) {
      console.log('│  ✗ Reverting — no improvement.')
      revertMutation(chosen, params)
    } else {
      console.log('│  ✓ Keeping improvement!')
    }

    previousTried.push({ ...chosen, accepted })

    const logText = logIteration({
      iteration: iter, timestamp: Date.now(), phase: 'complete',
      baseMetrics, baseScore, candidates, chosen, mutationResult,
      newMetrics, newScore, accepted, gaps,
      decision: accepted ? 'ACCEPTED' : 'REJECTED',
    })
    appendToPromptGen(logText)
    console.log(`└─ Iteration ${iter} complete ──────────────────────────────────┘`)
  }

  console.log('\n═══════════════════════════════════════════════════════')
  console.log(`  OODA complete. Audit trail → ${PROMPT_GEN}`)
  console.log('═══════════════════════════════════════════════════════')
}

// ─── Gap analysis helper ──────────────────────────────────────────────────
function analyzeGaps(m, scored) {
  const gaps = []
  const b = scored.breakdown

  if (b.winRate.score < 75)
    gaps.push(`Win rate ${m.winRate.toFixed(1)}% is below target (≥82%) — signal quality gap`)
  if (b.drawdown.score < 70)
    gaps.push(`Max drawdown ${m.maxDrawdownPct.toFixed(1)}% exceeds target (≤15%) — position sizing / stop-loss gap`)
  if (b.pnl.score < 60)
    gaps.push(`PnL $${fmt(m.totalPnl)} below target ($120K+) — alpha capture gap`)
  if (b.tradeCount.score < 70)
    gaps.push(`Trade count ${m.executedTrades} outside optimal range (25–40) — threshold calibration gap`)
  if (b.profitFactor.score < 60)
    gaps.push(`Profit factor ${m.profitFactor.toFixed(2)} below target (≥3.5) — exit timing gap`)
  if (gaps.length === 0)
    gaps.push('All metrics within target ranges — system operating at high efficiency')

  return gaps
}

// ─── Pretty-print score breakdown ────────────────────────────────────────
function printScore(s) {
  console.log('\n  ┌─ Score Breakdown ─────────────────────────────────┐')
  for (const [k, v] of Object.entries(s.breakdown)) {
    const bar = '█'.repeat(Math.floor(v.score / 5)) + '░'.repeat(20 - Math.floor(v.score / 5))
    console.log(`  │ ${k.padEnd(15)} ${bar} ${String(v.score).padStart(3)}/100  (${v.raw})`)
  }
  console.log(`  │${'─'.repeat(51)}`)
  console.log(`  │ COMPOSITE      ${''.padEnd(20)} ${s.score}/100`)
  console.log('  └──────────────────────────────────────────────────┘')
}

main().catch(e => { console.error('OODA loop error:', e); process.exit(1) })
