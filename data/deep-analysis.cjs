// AUTO-GENERATED analysis script
const fs = require("fs");
const path = require("path");
const tradesPath = path.join(__dirname, "..", "data", "backtest-trades.json");
const trades = JSON.parse(fs.readFileSync(tradesPath, "utf8"));
const fmt = (n) => n >= 0 ? ("+$" + n.toFixed(0)) : ("-$" + Math.abs(n).toFixed(0));
const pct = (n) => (n * 100).toFixed(1) + "%";
const sig = (t, k) => t.signal ? t.signal[k] : undefined;
const sep = (n) => "-".repeat(n || 80);
console.log("=".repeat(80));
console.log("DEEP BACKTEST ANALYSIS -- 44 Trades (Jan 2025 - Feb 2026)");
console.log("=".repeat(80));

// 1. ALL TRADES SORTED BY PNL
console.log("\n### 1. ALL 44 TRADES sorted by PnL descending\n");
const sorted = [...trades].sort((a,b) => b.pnl - a.pnl);
console.log("Rank  Asset  Dir     Protocol     PnL           Hours   Conf    Stage              ExitReason                              OpenedAt");
console.log(sep(130));
sorted.forEach((t,i) => {
  const hours  = (t.holdingPeriodMs/3600000).toFixed(1);
  const stage  = sig(t,"governanceStage") || "unknown";
  const cval   = sig(t,"confidence");
  const conf   = (cval != null) ? Number(cval).toFixed(3) : "n/a";
  const exit   = (t.exitReason || "unknown").substring(0,37);
  const opened = new Date(t.openedAt).toISOString().substring(0,10);
  console.log(
    String(i+1).padEnd(6) + (t.asset||"").padEnd(7) + (t.direction||"").padEnd(8) +
    (t.protocol||"").padEnd(13) + fmt(t.pnl).padEnd(14) + hours.padEnd(8) +
    conf.padEnd(8) + stage.padEnd(19) + exit.padEnd(39) + opened
  );
});

// 2. BY EXIT REASON
console.log("\n### 2. BY EXIT REASON\n");
const byExit = {};
for (const t of trades) {
  const reason = t.exitReason || "unknown";
  let r;
  if (reason.includes("trailing")) r = "trailing-stop";
  else if (reason.includes("stop-loss") || reason.includes("stop_loss")) r = "stop-loss";
  else if (reason.includes("take-profit") || reason.includes("take_profit")) r = "take-profit";
  else if (reason.includes("max-hold") || reason.includes("max_hold") || reason.includes("max holding")) r = "max-holding";
  else if (reason.includes("near-liquidation") || reason.includes("liquidation")) r = "near-liquidation";
  else r = reason.substring(0,30);
  if (!byExit[r]) byExit[r] = [];
  byExit[r].push(t);
}
const exitHdr = "ExitReason".padEnd(22)+"Count".padEnd(7)+"WR".padEnd(8)+"AvgPnL".padEnd(13)+"TotalPnL".padEnd(13)+"AvgHours";
console.log(exitHdr);
console.log(sep(70));
for (const [r, ts] of Object.entries(byExit).sort((a,b) => b[1].length - a[1].length)) {
  const wins  = ts.filter(t => t.pnl > 0).length;
  const avg   = ts.reduce((s,t) => s+t.pnl, 0) / ts.length;
  const total = ts.reduce((s,t) => s+t.pnl, 0);
  const avgH  = (ts.reduce((s,t) => s + t.holdingPeriodMs/3600000, 0) / ts.length).toFixed(0);
  console.log(r.padEnd(22)+String(ts.length).padEnd(7)+pct(wins/ts.length).padEnd(8)+fmt(avg).padEnd(13)+fmt(total).padEnd(13)+avgH+"h");
}

// 3. BY DIRECTION
console.log("\n### 3. BY DIRECTION\n");
const byDir = {};
for (const t of trades) { const d=t.direction||"?"; if (!byDir[d]) byDir[d]=[]; byDir[d].push(t); }
const dirHdr = "Direction".padEnd(12)+"Count".padEnd(7)+"WR".padEnd(8)+"AvgPnL".padEnd(13)+"TotalPnL".padEnd(13)+"Best".padEnd(13)+"Worst";
console.log(dirHdr); console.log(sep(80));
for (const [d,ts] of Object.entries(byDir)) {
  const wins=ts.filter(t=>t.pnl>0).length;
  const avg=ts.reduce((s,t)=>s+t.pnl,0)/ts.length;
  const total=ts.reduce((s,t)=>s+t.pnl,0);
  const best=Math.max(...ts.map(t=>t.pnl));
  const worst=Math.min(...ts.map(t=>t.pnl));
  console.log(d.padEnd(12)+String(ts.length).padEnd(7)+pct(wins/ts.length).padEnd(8)+fmt(avg).padEnd(13)+fmt(total).padEnd(13)+fmt(best).padEnd(13)+fmt(worst));
}

// 4. BY PROTOCOL
console.log("\n### 4. BY PROTOCOL (signal protocol)\n");
const byProto = {};
for (const t of trades) { const p=(sig(t,"protocol")||t.protocol||"?"); if (!byProto[p]) byProto[p]=[]; byProto[p].push(t); }
const protoHdr = "Protocol".padEnd(14)+"Count".padEnd(7)+"WR".padEnd(8)+"AvgPnL".padEnd(13)+"TotalPnL".padEnd(13)+"Assets";
console.log(protoHdr); console.log(sep(80));
for (const [p,ts] of Object.entries(byProto).sort((a,b)=>b[1].reduce((s,t)=>s+t.pnl,0)-a[1].reduce((s,t)=>s+t.pnl,0))) {
  const wins=ts.filter(t=>t.pnl>0).length;
  const avg=ts.reduce((s,t)=>s+t.pnl,0)/ts.length;
  const total=ts.reduce((s,t)=>s+t.pnl,0);
  const assets=[...new Set(ts.map(t=>t.asset))].join(",");
  console.log(p.padEnd(14)+String(ts.length).padEnd(7)+pct(wins/ts.length).padEnd(8)+fmt(avg).padEnd(13)+fmt(total).padEnd(13)+assets);
}

// 5. BY STAGE
console.log("\n### 5. BY GOVERNANCE STAGE\n");
const byStage = {};
for (const t of trades) { const s=sig(t,"governanceStage")||"unknown"; if (!byStage[s]) byStage[s]=[]; byStage[s].push(t); }
const stageHdr = "Stage".padEnd(18)+"Count".padEnd(7)+"WR".padEnd(8)+"AvgPnL".padEnd(13)+"TotalPnL".padEnd(13)+"AvgConf";
console.log(stageHdr); console.log(sep(72));
for (const [s,ts] of Object.entries(byStage).sort((a,b)=>b[1].length-a[1].length)) {
  const wins=ts.filter(t=>t.pnl>0).length;
  const avg=ts.reduce((s2,t)=>s2+t.pnl,0)/ts.length;
  const total=ts.reduce((s2,t)=>s2+t.pnl,0);
  const avgC=(ts.reduce((s2,t)=>s2+(sig(t,"confidence")||0),0)/ts.length).toFixed(3);
  console.log(s.padEnd(18)+String(ts.length).padEnd(7)+pct(wins/ts.length).padEnd(8)+fmt(avg).padEnd(13)+fmt(total).padEnd(13)+avgC);
}

// 6. CONFIDENCE BUCKETS
console.log("\n### 6. CONFIDENCE BUCKETS\n");
const buckets=[{l:"<0.60",mn:0,mx:0.60},{l:"0.60-0.65",mn:0.60,mx:0.65},{l:"0.65-0.70",mn:0.65,mx:0.70},{l:"0.70-0.75",mn:0.70,mx:0.75},{l:"0.75-0.80",mn:0.75,mx:0.80},{l:"0.80+",mn:0.80,mx:99}];
const buckHdr="Bucket".padEnd(12)+"Count".padEnd(7)+"WR".padEnd(8)+"AvgPnL".padEnd(13)+"TotalPnL".padEnd(13)+"Trades";
console.log(buckHdr); console.log(sep(95));
for (const b of buckets) {
  const ts=trades.filter(t=>{const c=sig(t,"confidence")||0; return c>=b.mn && c<b.mx;});
  if (ts.length===0){console.log(b.l.padEnd(12)+"0");continue;}
  const wins=ts.filter(t=>t.pnl>0).length;
  const avg=ts.reduce((s,t)=>s+t.pnl,0)/ts.length;
  const total=ts.reduce((s,t)=>s+t.pnl,0);
  const tlist=ts.map(t=>t.asset+"("+fmt(t.pnl)+")").join(" ");
  console.log(b.l.padEnd(12)+String(ts.length).padEnd(7)+pct(wins/ts.length).padEnd(8)+fmt(avg).padEnd(13)+fmt(total).padEnd(13)+tlist.substring(0,70));
}

// 7. 72H VIOLATIONS
console.log("\n### 7. TRADES WITH HOLD < 72h (SL gate violations)\n");
const violations=trades.filter(t=>t.holdingPeriodMs<72*3600000);
if (violations.length===0) {
  console.log("  PASS: No violations -- all 44 trades held >= 72h");
} else {
  console.log("  VIOLATIONS: "+violations.length);
  violations.forEach(t=>{
    const h=(t.holdingPeriodMs/3600000).toFixed(1);
    console.log("  "+t.asset+" "+t.direction+" "+h+"h  exit:"+t.exitReason+"  PnL:"+fmt(t.pnl));
  });
}

// 8. LOSING TRADES
console.log("\n### 8. ALL LOSING TRADES -- detail\n");
const losers=trades.filter(t=>t.pnl<=0).sort((a,b)=>a.pnl-b.pnl);
console.log("Found "+losers.length+" losing trades\n");
const loserHdr="Asset".padEnd(6)+"Dir".padEnd(6)+"Conf".padEnd(7)+"Stage".padEnd(16)+"Hours".padEnd(8)+"PnL".padEnd(13)+"ExitReason";
console.log(loserHdr); console.log(sep(90));
losers.forEach(t=>{
  const h=(t.holdingPeriodMs/3600000).toFixed(1);
  const stage=sig(t,"governanceStage")||"unknown";
  const cval=sig(t,"confidence");
  const conf=(cval != null) ? Number(cval).toFixed(3) : "n/a";
  console.log((t.asset||"").padEnd(6)+(t.direction||"").padEnd(6)+conf.padEnd(7)+stage.padEnd(16)+h.padEnd(8)+fmt(t.pnl).padEnd(13)+(t.exitReason||"").substring(0,50));
});

// 9. MAX-HOLDING EXITS
console.log("\n### 9. MAX-HOLDING EXITS -- were they profitable?\n");
const mhByReason=trades.filter(t=>{const r=(t.exitReason||"").toLowerCase(); return r.includes("max-hold")||r.includes("max_hold")||r.includes("max holding")||r.includes("maxhold");});
const mhByTime=trades.filter(t=>t.holdingPeriodMs>=718*3600000);
const seenMH=new Set();
const maxHAll=[...mhByReason,...mhByTime].filter(t=>{if(seenMH.has(t.openedAt)) return false; seenMH.add(t.openedAt); return true;});
console.log("Found "+maxHAll.length+" max-holding exits (by exitReason OR >=718h hold)");
const mhHdr="Asset".padEnd(6)+"Dir".padEnd(6)+"Hours".padEnd(8)+"PnL".padEnd(13)+"ActMove%".padEnd(12)+"TP%".padEnd(9)+"Profitable?";
console.log(mhHdr); console.log(sep(75));
maxHAll.forEach(t=>{
  const h=(t.holdingPeriodMs/3600000).toFixed(1);
  const move=t.direction==="short"?(t.entryPrice-t.exitPrice)/t.entryPrice:(t.exitPrice-t.entryPrice)/t.entryPrice;
  const tp=sig(t,"takeProfitPct")||0;
  const prof=t.pnl>0?"YES -- profitable forced exit":"NO -- loss at max-hold";
  console.log((t.asset||"").padEnd(6)+(t.direction||"").padEnd(6)+h.padEnd(8)+fmt(t.pnl).padEnd(13)+pct(move).padEnd(12)+pct(tp).padEnd(9)+prof);
});

// 10. AVG HOLDING BY EXIT REASON
console.log("\n### 10. AVG HOLDING HOURS BY EXIT REASON\n");
const holdHdr="ExitReason".padEnd(22)+"Count".padEnd(7)+"AvgHours".padEnd(10)+"MinHours".padEnd(10)+"MaxHours";
console.log(holdHdr); console.log(sep(60));
for (const [r,ts] of Object.entries(byExit).sort((a,b)=>(a[1].reduce((s,t)=>s+t.holdingPeriodMs,0)/a[1].length)-(b[1].reduce((s,t)=>s+t.holdingPeriodMs,0)/b[1].length))) {
  const hrs=ts.map(t=>t.holdingPeriodMs/3600000);
  const avg=(hrs.reduce((s,h)=>s+h,0)/hrs.length).toFixed(0);
  const mn=Math.min(...hrs).toFixed(0);
  const mx=Math.max(...hrs).toFixed(0);
  console.log(r.padEnd(22)+String(ts.length).padEnd(7)+(avg+"h").padEnd(10)+(mn+"h").padEnd(10)+mx+"h");
}

// 11. BY MONTH
console.log("\n### 11. TRADES BY MONTH -- temporal pattern\n");
const byMonth={};
for (const t of trades) {
  const d=new Date(t.openedAt);
  const k=d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0");
  if (!byMonth[k]) byMonth[k]=[];
  byMonth[k].push(t);
}
const monthHdr="Month".padEnd(10)+"Count".padEnd(7)+"WR".padEnd(8)+"AvgPnL".padEnd(13)+"TotalPnL".padEnd(13)+"Cumulative";
console.log(monthHdr); console.log(sep(70));
let cum=0;
for (const [m,ts] of Object.entries(byMonth).sort()) {
  const wins=ts.filter(t=>t.pnl>0).length;
  const avg=ts.reduce((s,t)=>s+t.pnl,0)/ts.length;
  const total=ts.reduce((s,t)=>s+t.pnl,0);
  cum+=total;
  console.log(m.padEnd(10)+String(ts.length).padEnd(7)+pct(wins/ts.length).padEnd(8)+fmt(avg).padEnd(13)+fmt(total).padEnd(13)+fmt(cum));
}

// 12. TP LEVEL ANALYSIS
console.log("\n### 12. TAKE-PROFIT LEVEL ANALYSIS\n");
console.log("For each trade: actual price move vs TP target\n");
const tpHdr="Asset".padEnd(6)+"Dir".padEnd(6)+"PnL".padEnd(11)+"ActMove%".padEnd(11)+"TP%".padEnd(9)+"Achieved%".padEnd(12)+"ExitReason";
console.log(tpHdr); console.log(sep(90));
[...trades].sort((a,b)=>b.pnl-a.pnl).forEach(t=>{
  const move=t.direction==="short"?(t.entryPrice-t.exitPrice)/t.entryPrice:(t.exitPrice-t.entryPrice)/t.entryPrice;
  const tp=sig(t,"takeProfitPct");
  const achieved=tp ? (move/tp*100).toFixed(0)+"%" : "n/a";
  const tpStr=tp != null ? pct(tp) : "n/a";
  const exit=(t.exitReason||"").substring(0,35);
  console.log((t.asset||"").padEnd(6)+(t.direction||"").padEnd(6)+fmt(t.pnl).padEnd(11)+pct(move).padEnd(11)+tpStr.padEnd(9)+achieved.padEnd(12)+exit);
});

// 13. LEVERAGE
console.log("\n### 13. LEVERAGE DISTRIBUTION\n");
const byLev={};
for (const t of trades) { const lev=sig(t,"leverage")||"?"; if (!byLev[lev]) byLev[lev]=[]; byLev[lev].push(t); }
const levHdr="Leverage".padEnd(10)+"Count".padEnd(7)+"WR".padEnd(8)+"AvgPnL".padEnd(13)+"TotalPnL".padEnd(13)+"Assets";
console.log(levHdr); console.log(sep(75));
for (const [lev,ts] of Object.entries(byLev).sort((a,b)=>Number(a[0])-Number(b[0]))) {
  const wins=ts.filter(t=>t.pnl>0).length;
  const avg=ts.reduce((s,t)=>s+t.pnl,0)/ts.length;
  const total=ts.reduce((s,t)=>s+t.pnl,0);
  const assets=[...new Set(ts.map(t=>t.asset))].join(",");
  console.log(String(lev+"x").padEnd(10)+String(ts.length).padEnd(7)+pct(wins/ts.length).padEnd(8)+fmt(avg).padEnd(13)+fmt(total).padEnd(13)+assets);
}

// 14. KEYWORDS
console.log("\n### 14. SIGNAL RATIONALE KEYWORDS\n");
const kws=["parameter decrease","parameter increase","risk","freeze","collateral","fee","upgrade","liquidation","emission","borrow","supply cap","interest rate","bearish","bullish"];
for (const kw of kws) {
  const ts=trades.filter(t=>(sig(t,"rationale")||"").toLowerCase().includes(kw));
  if (!ts.length) continue;
  const wins=ts.filter(t=>t.pnl>0).length;
  const total=ts.reduce((s,t)=>s+t.pnl,0);
  console.log("  "+JSON.stringify(kw)+": "+ts.length+" trades, WR "+pct(wins/ts.length)+", total "+fmt(total));
}

// 15. SUMMARY
console.log("\n### 15. SUMMARY STATS\n");
const totalPnl=trades.reduce((s,t)=>s+t.pnl,0);
const wins2=trades.filter(t=>t.pnl>0);
const losses2=trades.filter(t=>t.pnl<=0);
const grossWin=wins2.reduce((s,t)=>s+t.pnl,0);
const grossLoss=Math.abs(losses2.reduce((s,t)=>s+t.pnl,0));
const avgHold=(trades.reduce((s,t)=>s+t.holdingPeriodMs/3600000,0)/trades.length).toFixed(0);
console.log("Total trades:      "+trades.length);
console.log("Winners:           "+wins2.length+" ("+pct(wins2.length/trades.length)+")");
console.log("Losers:            "+losses2.length+" ("+pct(losses2.length/trades.length)+")");
console.log("Total PnL:         "+fmt(totalPnl));
console.log("Avg PnL/trade:     "+fmt(totalPnl/trades.length));
console.log("Best trade:        "+fmt(Math.max(...trades.map(t=>t.pnl))));
console.log("Worst trade:       "+fmt(Math.min(...trades.map(t=>t.pnl))));
console.log("Gross profit:      "+fmt(grossWin));
console.log("Gross loss:        -$"+grossLoss.toFixed(0));
console.log("Profit factor:     "+(grossWin/grossLoss).toFixed(2));
console.log("Avg hold:          "+avgHold+"h");
console.log("Short trades:      "+trades.filter(t=>t.direction==="short").length);
console.log("Long trades:       "+trades.filter(t=>t.direction==="long").length);
console.log("\n"+"=".repeat(80));
console.log("END OF ANALYSIS");
console.log("=".repeat(80));
