const fs = require("fs");
const trades = JSON.parse(fs.readFileSync("data/backtest-trades.json", "utf8"));
const fmt = (n) => n >= 0 ? ("+$" + n.toFixed(0)) : ("-$" + Math.abs(n).toFixed(0));
const pct = (n) => (n * 100).toFixed(1) + "%";
const fN  = (n, d) => Number(n).toFixed(d == null ? 2 : d);
const sig = (t, k) => t.signal ? t.signal[k] : undefined;

console.log("=".repeat(80));
console.log("DEEP BACKTEST ANALYSIS -- 44 Trades (Jan 2025 - Feb 2026)");
console.log("=".repeat(80));

// --- 1. ALL TRADES SORTED BY PNL ---
console.log("
### 1. ALL 44 TRADES sorted by PnL descending
");
const sorted = [...trades].sort((a,b) => b.pnl - a.pnl);
console.log("Rank  Asset  Dir     Protocol     PnL           Hours   Conf    Stage              ExitReason                              OpenedAt");
console.log("-".repeat(130));
sorted.forEach((t,i) => {
  const hours  = (t.holdingPeriodMs/3600000).toFixed(1);
  const stage  = sig(t,"governanceStage") || "unknown";
  const conf   = sig(t,"confidence") != null ? Number(sig(t,"confidence")).toFixed(3) : "n/a";
  const exit   = (t.exitReason || "unknown").substring(0,37);
  const opened = new Date(t.openedAt).toISOString().substring(0,10);
  console.log(
    String(i+1).padEnd(6) + (t.asset||"?").padEnd(7) + (t.direction||"?").padEnd(8) +
    (t.protocol||"?").padEnd(13) + fmt(t.pnl).padEnd(14) + hours.padEnd(8) +
    conf.padEnd(8) + stage.padEnd(19) + exit.padEnd(39) + opened
  );
});