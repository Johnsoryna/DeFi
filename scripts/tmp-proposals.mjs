import fs from "fs";
import Database from "better-sqlite3";

const DB_PATH = "C:/Code/DeFi/data/backtest.db";
const TRADES_PATH = "C:/Code/DeFi/data/backtest-trades.json";
const REPORT_PATH = "C:/Code/DeFi/data/backtest-report.json";

console.log("SCHEMA CHECK");
const db = new Database(DB_PATH, { readonly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log("Tables:", tables.map(t => t.name).join(", "));
tables.forEach(tbl => {
  const cols = db.prepare("PRAGMA table_info(" + tbl.name + ")").all();
  const count = db.prepare("SELECT COUNT(*) as c FROM " + tbl.name).get();
  console.log("\nTable:", tbl.name, "(", count.c, "rows)");
  console.log("  Cols:", cols.map(c => c.name + "(" + c.type + ")").join(", "));
  const sample = db.prepare("SELECT * FROM " + tbl.name + " LIMIT 1").get();
  if (sample) console.log("  Sample:", JSON.stringify(sample).slice(0,300));
});
db.close();
