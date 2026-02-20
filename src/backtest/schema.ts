/**
 * SQLite schema for the backtesting historical-data cache.
 * Separate from the production schema in lib/store.ts.
 */
import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { createLogger } from '../lib/logger.js'

const log = createLogger('backtest-schema')

/**
 * Initialize (or open) the backtest data cache database
 * and create the required tables if they don't exist.
 */
export function initBacktestStore(dbPath: string): Database.Database {
  const dbDir = path.dirname(dbPath)
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true })
  }

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    -- Raw on-chain governance events
    CREATE TABLE IF NOT EXISTS historical_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      block_number INTEGER NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      contract_address TEXT NOT NULL,
      event_name TEXT NOT NULL,
      args_json TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      UNIQUE(tx_hash, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_hist_events_ts ON historical_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_hist_events_contract ON historical_events(contract_address);

    -- Historical price snapshots
    CREATE TABLE IF NOT EXISTS historical_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      price TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'defillama',
      UNIQUE(asset, timestamp)
    );
    CREATE INDEX IF NOT EXISTS idx_hist_prices_asset_ts ON historical_prices(asset, timestamp);

    -- Historical Snapshot proposals
    CREATE TABLE IF NOT EXISTS historical_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT NOT NULL UNIQUE,
      space TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      state TEXT NOT NULL,
      start INTEGER NOT NULL,
      "end" INTEGER NOT NULL,
      scores_json TEXT,
      author TEXT,
      choices_json TEXT,
      scores_total REAL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hist_snap_space ON historical_snapshots(space);
    CREATE INDEX IF NOT EXISTS idx_hist_snap_ts ON historical_snapshots(created_at);

    -- Historical forum posts
    CREATE TABLE IF NOT EXISTS historical_forum_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id INTEGER NOT NULL,
      forum_url TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      category_id INTEGER DEFAULT 0,
      posts_count INTEGER DEFAULT 0,
      reply_count INTEGER DEFAULT 0,
      views INTEGER DEFAULT 0,
      UNIQUE(forum_url, topic_id)
    );
    CREATE INDEX IF NOT EXISTS idx_hist_forum_ts ON historical_forum_posts(created_at);

    -- Metadata: track collection progress for incremental fetches
    CREATE TABLE IF NOT EXISTS collection_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  log.info({ dbPath }, 'Backtest store initialized')
  return db
}
