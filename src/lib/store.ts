/**
 * SQLite persistence layer using better-sqlite3.
 * Manages processed events, proposal state, positions, and alert logs.
 */
import Database from 'better-sqlite3'
import { createLogger } from './logger.js'
import { config } from '../config/index.js'
import path from 'node:path'
import fs from 'node:fs'

const log = createLogger('store')

let db: Database.Database
let dbClosed = false

/**
 * Initialize SQLite database and create tables.
 */
export function initStore(): Database.Database {
  const dbDir = path.dirname(config.dbPath)
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true })
  }

  dbClosed = false
  db = new Database(config.dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      block_number INTEGER NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      protocol TEXT NOT NULL,
      processed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tx_hash, log_index)
    );

    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      protocol TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'monitoring',
      title TEXT,
      classification TEXT, -- JSON array of ImpactCategory
      for_votes TEXT DEFAULT '0',
      against_votes TEXT DEFAULT '0',
      analysis TEXT,       -- JSON ProposalAnalysis
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS positions (
      id TEXT PRIMARY KEY,
      protocol TEXT NOT NULL,
      type TEXT NOT NULL,
      asset TEXT NOT NULL,
      size TEXT NOT NULL,
      entry_price TEXT NOT NULL,
      current_price TEXT DEFAULT '0',
      unrealized_pnl TEXT DEFAULT '0',
      realized_pnl TEXT DEFAULT '0',
      accrued_yield TEXT DEFAULT '0',
      health_factor REAL,
      maturity TEXT,
      last_updated TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS alerts_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      channel TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata TEXT,        -- JSON
      sent_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS block_cursors (
      contract_address TEXT PRIMARY KEY,
      last_block INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS snapshot_cursors (
      space TEXT PRIMARY KEY,
      last_seen_id TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS forum_cursors (
      forum_url TEXT PRIMARY KEY,
      last_topic_id INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_events_block ON processed_events(block_number);
    CREATE INDEX IF NOT EXISTS idx_events_protocol ON processed_events(protocol);
    CREATE INDEX IF NOT EXISTS idx_proposals_stage ON proposals(stage);
    CREATE INDEX IF NOT EXISTS idx_positions_protocol ON positions(protocol);
  `)

  log.info({ dbPath: config.dbPath }, 'Database initialized')

  // Prune processed_events older than 90 days on startup.
  // Prevents unbounded table growth on long-running bots without impacting de-dup correctness.
  pruneOldEvents(90)

  return db
}

/**
 * Get the database instance (must call initStore first).
 */
export function getDb(): Database.Database {
  if (!db) throw new Error('Store not initialized. Call initStore() first.')
  if (dbClosed) throw new Error('Store has been closed. Cannot perform database operations.')
  return db
}

// ─── Block Cursor Operations ────────────────────────────────────────

export function getLastProcessedBlock(contractAddress: string): bigint {
  const row = getDb()
    .prepare('SELECT last_block FROM block_cursors WHERE contract_address = ?')
    .get(contractAddress) as { last_block: number } | undefined
  return row ? BigInt(row.last_block) : 0n
}

export function setLastProcessedBlock(contractAddress: string, blockNumber: bigint): void {
  // Use string representation to avoid precision loss for very large block numbers
  const blockStr = blockNumber.toString()
  getDb()
    .prepare(
      `INSERT INTO block_cursors (contract_address, last_block, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(contract_address) DO UPDATE SET last_block = ?, updated_at = datetime('now')`,
    )
    .run(contractAddress, blockStr, blockStr)
}

// ─── Processed Events ───────────────────────────────────────────────

export function isEventProcessed(txHash: string, logIndex: number): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM processed_events WHERE tx_hash = ? AND log_index = ?')
    .get(txHash, logIndex)
  return !!row
}

export function markEventProcessed(
  blockNumber: bigint,
  txHash: string,
  logIndex: number,
  eventType: string,
  protocol: string,
): void {
  // Use string representation to avoid precision loss
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO processed_events (block_number, tx_hash, log_index, event_type, protocol)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(blockNumber.toString(), txHash, logIndex, eventType, protocol)
}

export function rollbackEvent(txHash: string, logIndex?: number): void {
  // If logIndex provided, delete only that specific event; otherwise delete all events with that txHash
  if (logIndex !== undefined) {
    getDb().prepare('DELETE FROM processed_events WHERE tx_hash = ? AND log_index = ?').run(txHash, logIndex)
  } else {
    getDb().prepare('DELETE FROM processed_events WHERE tx_hash = ?').run(txHash)
  }
}

/**
 * Prune processed_events rows older than retentionDays (default 90).
 * The de-duplication guard only needs to cover re-org depth + replay window.
 * Long-running bots accumulate millions of rows without this — causes slow queries.
 * Called at startup; also safe to call periodically.
 */
export function pruneOldEvents(retentionDays = 90): void {
  const result = getDb()
    .prepare(`DELETE FROM processed_events WHERE processed_at < datetime('now', ?)`)
    .run(`-${retentionDays} days`)
  if ((result.changes ?? 0) > 0) {
    log.info({ deleted: result.changes, retentionDays }, 'Pruned old processed_events')
  }
}

// ─── Proposal Operations ────────────────────────────────────────────

export function upsertProposal(proposal: {
  id: string
  protocol: string
  stage: string
  title?: string
  classification?: string[]
  forVotes?: string
  againstVotes?: string
  analysis?: string
}): void {
  getDb()
    .prepare(
      `INSERT INTO proposals (id, protocol, stage, title, classification, for_votes, against_votes, analysis, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         stage = ?,
         title = COALESCE(?, title),
         classification = COALESCE(?, classification),
         for_votes = COALESCE(?, for_votes),
         against_votes = COALESCE(?, against_votes),
         analysis = COALESCE(?, analysis),
         updated_at = datetime('now')`,
    )
    .run(
      proposal.id,
      proposal.protocol,
      proposal.stage,
      proposal.title ?? null,
      proposal.classification ? JSON.stringify(proposal.classification) : null,
      proposal.forVotes ?? '0',
      proposal.againstVotes ?? '0',
      proposal.analysis ?? null,
      // ON CONFLICT SET values
      proposal.stage,
      proposal.title ?? null,
      proposal.classification ? JSON.stringify(proposal.classification) : null,
      proposal.forVotes ?? null,
      proposal.againstVotes ?? null,
      proposal.analysis ?? null,
    )
}

export function getProposal(id: string) {
  return getDb().prepare('SELECT * FROM proposals WHERE id = ?').get(id) as Record<string, unknown> | undefined
}

export function getActiveProposals() {
  return getDb()
    .prepare("SELECT * FROM proposals WHERE stage NOT IN ('executed', 'canceled') ORDER BY updated_at DESC")
    .all() as Record<string, unknown>[]
}

// ─── Position Operations ────────────────────────────────────────────

export function upsertPosition(pos: {
  id: string
  protocol: string
  type: string
  asset: string
  size: string
  entryPrice: string
  currentPrice?: string
  unrealizedPnl?: string
  realizedPnl?: string
  accruedYield?: string
  healthFactor?: number
  maturity?: string
}): void {
  getDb()
    .prepare(
      `INSERT INTO positions (id, protocol, type, asset, size, entry_price, current_price, unrealized_pnl, realized_pnl, accrued_yield, health_factor, maturity, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         entry_price = ?, size = ?, current_price = ?, unrealized_pnl = ?, realized_pnl = ?,
         accrued_yield = ?, health_factor = ?, maturity = ?, last_updated = datetime('now')`,
    )
    .run(
      pos.id, pos.protocol, pos.type, pos.asset, pos.size, pos.entryPrice,
      pos.currentPrice ?? '0', pos.unrealizedPnl ?? '0', pos.realizedPnl ?? '0',
      pos.accruedYield ?? '0', pos.healthFactor ?? null, pos.maturity ?? null,
      // ON CONFLICT SET values
      pos.entryPrice, pos.size, pos.currentPrice ?? '0', pos.unrealizedPnl ?? '0', pos.realizedPnl ?? '0',
      pos.accruedYield ?? '0', pos.healthFactor ?? null, pos.maturity ?? null,
    )
}

export function getPositions(protocol?: string) {
  if (protocol) {
    return getDb().prepare('SELECT * FROM positions WHERE protocol = ?').all(protocol) as Record<string, unknown>[]
  }
  return getDb().prepare('SELECT * FROM positions').all() as Record<string, unknown>[]
}

export function deletePosition(id: string): void {
  getDb().prepare('DELETE FROM positions WHERE id = ?').run(id)
}

// ─── Alert Log ──────────────────────────────────────────────────────

export function logAlert(alert: {
  type: string
  severity: string
  channel: string
  title: string
  message: string
  metadata?: Record<string, unknown>
}): void {
  getDb()
    .prepare(
      `INSERT INTO alerts_log (alert_type, severity, channel, title, message, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(alert.type, alert.severity, alert.channel, alert.title, alert.message,
      alert.metadata ? JSON.stringify(alert.metadata) : null)
}

// ─── Forum Cursors ──────────────────────────────────────────────────

export function getForumCursor(forumUrl: string): number {
  const row = getDb()
    .prepare('SELECT last_topic_id FROM forum_cursors WHERE forum_url = ?')
    .get(forumUrl) as { last_topic_id: number } | undefined
  return row?.last_topic_id ?? 0
}

export function setForumCursor(forumUrl: string, lastTopicId: number): void {
  getDb()
    .prepare(
      `INSERT INTO forum_cursors (forum_url, last_topic_id, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(forum_url) DO UPDATE SET last_topic_id = ?, updated_at = datetime('now')`,
    )
    .run(forumUrl, lastTopicId, lastTopicId)
}

// ─── Snapshot Cursors ───────────────────────────────────────────────

export function getSnapshotCursor(space: string): string | null {
  const row = getDb()
    .prepare('SELECT last_seen_id FROM snapshot_cursors WHERE space = ?')
    .get(space) as { last_seen_id: string } | undefined
  return row?.last_seen_id ?? null
}

export function setSnapshotCursor(space: string, lastSeenId: string): void {
  getDb()
    .prepare(
      `INSERT INTO snapshot_cursors (space, last_seen_id, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(space) DO UPDATE SET last_seen_id = ?, updated_at = datetime('now')`,
    )
    .run(space, lastSeenId, lastSeenId)
}

// ─── Cleanup ────────────────────────────────────────────────────────

export function closeStore(): void {
  if (db && !dbClosed) {
    db.close()
    dbClosed = true
    log.info('Database closed')
  }
}

/**
 * Reset the closed flag (for testing purposes).
 */
export function resetDbState(): void {
  dbClosed = false
}
