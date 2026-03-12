/**
 * Portfolio size sweep — finds the breakeven point where % return plateaus.
 * Tests INITIAL_PORTFOLIO from $10 to $300 to find where gains stop increasing.
 */
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';

const FROM = '2025-01-01';
const TO   = '2026-02-20';

// Test these portfolio sizes
const sizes = [
  10, 15, 20, 25, 30, 35, 40, 45, 50, 55,
  60, 70, 80, 90, 100, 125, 150, 200, 300, 500
];

console.log(`Portfolio sweep: ${FROM} → ${TO}`);
console.log(`Testing ${sizes.length} portfolio sizes...\n`);
console.log('Portfolio | Trades | PnL $    | PnL %   | Win Rate');
console.log('----------|--------|----------|---------|----------');

const REPORT_PATH = 'data/backtest-report.json';
const hadOriginal = existsSync(REPORT_PATH);
const originalReport = hadOriginal ? readFileSync(REPORT_PATH, 'utf8') : null;

try {
  for (const size of sizes) {
    try {
      execSync(
        `npx tsx src/backtest/index.ts run --from ${FROM} --to ${TO} --portfolio ${size}`,
        { stdio: 'ignore', timeout: 120_000 }
      );

      const report = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
      const s = report.summary;
      const p = report.performance;
      const pnlPct = ((s.totalPnl / size) * 100).toFixed(1);
      const wr = Number(p?.winRate ?? 0).toFixed(1);

      console.log(
        `$${String(size).padStart(6)}   | ${String(s.executedTrades).padStart(6)} | $${String(s.totalPnl.toFixed(0)).padStart(7)} | ${String(pnlPct).padStart(6)}% | ${wr}%`
      );
    } catch (e) {
      console.log(`$${String(size).padStart(6)}   | ERROR: ${e.message?.slice(0, 50)}`);
    }
  }
} finally {
  // Keep the repository clean after sweeps.
  if (hadOriginal && originalReport !== null) {
    writeFileSync(REPORT_PATH, originalReport, 'utf8');
  }
}

console.log('\nDone.');
