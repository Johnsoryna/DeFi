/**
 * LLM Pre-compute Script (Hebel 2)
 *
 * Runs gemma2:2b via Ollama on borderline proposals where keyword NLP
 * doesn't classify as risk_mitigation but LLM might find semantic risk signals.
 *
 * Output: data/llm-cache.json
 *
 * Usage: npx tsx scripts/llm-precompute.ts [--dry-run] [--limit N]
 */

import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

const DB_PATH = path.join(process.cwd(), 'data/backtest.db')
const CACHE_PATH = path.join(process.cwd(), 'data/llm-cache.json')
const OLLAMA_URL = 'http://localhost:11434/api/generate'
const MODEL = 'gemma2:2b'

const isDryRun = process.argv.includes('--dry-run')
const limitArg = process.argv.indexOf('--limit')
const maxCandidates = limitArg >= 0 ? parseInt(process.argv[limitArg + 1]) : Infinity

// ── Risk pre-screen keywords (broad — LLM does final classification) ─────────
// We send to LLM if ANY of these appear in title+body
const RISK_PRESCREEN = [
  /\brisk\b/i,
  /\bcollateral\b/i,
  /\bcap\b/i,
  /\blimit\b/i,
  /\bfreeze\b/i,
  /\bhalt\b/i,
  /\bpause\b/i,
  /\bemergency\b/i,
  /\bdeactivat/i,
  /\bdeprecation\b/i,
  /\boffboard\b/i,
  /\bsuspend/i,
  /\bexposure\b/i,
  /\bltv\b/i,
  /\bliquidat/i,
  /\bthreshold\b/i,
  /\bconservative\b/i,
  /\btighten/i,
  /\bdebt ceiling\b/i,
  /\bshortfall\b/i,
  /\bbad debt\b/i,
]

// ── LLM prompt ───────────────────────────────────────────────────────────────
function buildPrompt(title: string, bodyExcerpt: string): string {
  return `You are a DeFi governance analyst. Classify this proposal strictly.

Title: ${title}
${bodyExcerpt ? `Body: ${bodyExcerpt}` : ''}

TASK: Is this a RISK_MITIGATION proposal?
RISK_MITIGATION includes: asset freezes, supply/borrow cap reductions, LTV/LT decreases, collateral offboarding, emergency actions, exposure limit tightening.
NOT RISK_MITIGATION: cap increases, grant approvals, treasury management, new asset listings (adding new assets), protocol upgrades, gauge votes, parameter increases.

Respond with JSON only, no other text:
{"type":"risk_mitigation","bearish":true,"confidence":0.85}
or
{"type":"other","bearish":false,"confidence":0.80}

JSON:`
}

// ── Call Ollama ───────────────────────────────────────────────────────────────
async function callLLM(prompt: string): Promise<{ type: string; bearish: boolean; confidence: number } | null> {
  try {
    const resp = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        prompt,
        stream: false,
        options: { temperature: 0.1, num_predict: 60 },
      }),
    })
    if (!resp.ok) {
      console.error(`Ollama HTTP ${resp.status}`)
      return null
    }
    const data = await resp.json() as { response?: string }
    const raw = (data.response ?? '').trim()

    // Extract JSON from response
    const match = raw.match(/\{[^}]+\}/)
    if (!match) {
      console.error(`  No JSON in LLM response: "${raw.slice(0, 80)}"`)
      return null
    }
    return JSON.parse(match[0])
  } catch (e) {
    console.error(`  LLM call failed: ${e}`)
    return null
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const db = new Database(DB_PATH, { readonly: true })

  // Load existing cache
  let cache: Record<string, { type: string; bearish: boolean; confidence: number }> = {}
  if (fs.existsSync(CACHE_PATH)) {
    cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'))
    console.log(`Loaded existing cache: ${Object.keys(cache).length} entries`)
  }

  // Get all snapshot proposals
  const snapshots = db.prepare(`
    SELECT proposal_id, space, title, body, created_at
    FROM historical_snapshots
    ORDER BY created_at DESC
  `).all() as Array<{ proposal_id: string; space: string; title: string; body: string | null; created_at: string }>

  console.log(`Total snapshots in DB: ${snapshots.length}`)

  // Filter to borderline candidates
  const candidates = snapshots.filter(snap => {
    // Skip if already in cache
    if (cache[snap.proposal_id]) return false

    const combined = `${snap.title} ${(snap.body ?? '').slice(0, 300)}`
    return RISK_PRESCREEN.some(re => re.test(combined))
  })

  const limited = candidates.slice(0, maxCandidates === Infinity ? candidates.length : maxCandidates)

  console.log(`Candidates (risk pre-screen, not in cache): ${candidates.length}`)
  console.log(`Will process: ${limited.length}${isDryRun ? ' (DRY RUN — no LLM calls)' : ''}`)
  console.log(`Estimated time: ~${Math.ceil(limited.length * 3 / 60)} minutes`)

  if (isDryRun) {
    // Show samples
    console.log('\nSample candidates:')
    limited.slice(0, 10).forEach(snap => {
      console.log(`  [${snap.space}] ${snap.title.slice(0, 80)}`)
    })
    db.close()
    return
  }

  // Process candidates
  let processed = 0
  let reclassified = 0
  const newEntries: typeof cache = {}

  for (const snap of limited) {
    const bodyExcerpt = (snap.body ?? '').slice(0, 200).replace(/\n+/g, ' ').trim()
    const prompt = buildPrompt(snap.title, bodyExcerpt)

    process.stdout.write(`[${processed + 1}/${limited.length}] ${snap.title.slice(0, 60)}... `)

    const result = await callLLM(prompt)
    if (!result) {
      console.log('FAILED')
      processed++
      continue
    }

    const isRisk = result.type === 'risk_mitigation' && result.confidence >= 0.65
    console.log(`${result.type} (conf=${result.confidence.toFixed(2)}, bearish=${result.bearish}) ${isRisk ? '✓ CACHED' : ''}`)

    if (isRisk) {
      newEntries[snap.proposal_id] = result
      reclassified++
    }

    processed++

    // Save cache every 20 entries
    if (processed % 20 === 0) {
      const merged = { ...cache, ...newEntries }
      fs.writeFileSync(CACHE_PATH, JSON.stringify(merged, null, 2))
      console.log(`  → Saved cache (${Object.keys(merged).length} entries)`)
    }
  }

  // Final save
  const merged = { ...cache, ...newEntries }
  fs.writeFileSync(CACHE_PATH, JSON.stringify(merged, null, 2))

  console.log(`\n══════════════════════════════`)
  console.log(`Processed: ${processed}`)
  console.log(`Reclassified as risk_mitigation: ${reclassified}`)
  console.log(`Cache saved to: ${CACHE_PATH}`)
  console.log(`Total cache entries: ${Object.keys(merged).length}`)

  db.close()
}

main().catch(console.error)
