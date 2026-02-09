/**
 * Tests for SQLite store operations.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  initStore,
  closeStore,
  getLastProcessedBlock,
  setLastProcessedBlock,
  isEventProcessed,
  markEventProcessed,
  rollbackEvent,
  upsertProposal,
  getProposal,
  getActiveProposals,
  upsertPosition,
  getPositions,
  deletePosition,
  logAlert,
  getForumCursor,
  setForumCursor,
  getSnapshotCursor,
  setSnapshotCursor,
} from '../../src/lib/store.js'
import fs from 'node:fs'

const TEST_DB_PATH = './data/test-store.db'

beforeAll(() => {
  // Override config DB path via env
  process.env.DB_PATH = TEST_DB_PATH
  // Remove leftover test DB
  for (const f of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
  initStore()
})

afterAll(() => {
  closeStore()
  for (const f of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

describe('block cursors', () => {
  it('returns 0n for unknown contract', () => {
    expect(getLastProcessedBlock('0xunknown')).toBe(0n)
  })

  it('sets and gets block cursor', () => {
    setLastProcessedBlock('0xAABB', 12345n)
    expect(getLastProcessedBlock('0xAABB')).toBe(12345n)
  })

  it('updates existing cursor', () => {
    setLastProcessedBlock('0xAABB', 12345n)
    setLastProcessedBlock('0xAABB', 67890n)
    expect(getLastProcessedBlock('0xAABB')).toBe(67890n)
  })
})

describe('processed events', () => {
  it('returns false for unprocessed event', () => {
    expect(isEventProcessed('0xtx1', 0)).toBe(false)
  })

  it('marks and checks event as processed', () => {
    markEventProcessed(100n, '0xtx1', 0, 'ProposalCreated', 'compound')
    expect(isEventProcessed('0xtx1', 0)).toBe(true)
  })

  it('handles duplicate inserts gracefully', () => {
    markEventProcessed(100n, '0xtx1', 0, 'ProposalCreated', 'compound')
    expect(isEventProcessed('0xtx1', 0)).toBe(true)
  })

  it('rollback removes event', () => {
    markEventProcessed(200n, '0xtx2', 0, 'VoteCast', 'uniswap')
    expect(isEventProcessed('0xtx2', 0)).toBe(true)
    rollbackEvent('0xtx2')
    expect(isEventProcessed('0xtx2', 0)).toBe(false)
  })
})

describe('proposals', () => {
  it('creates a new proposal', () => {
    upsertProposal({
      id: 'compound:42',
      protocol: 'compound',
      stage: 'onchain_vote',
      title: 'Set WETH LTV to 80%',
      classification: ['ltv_change'],
    })
    const p = getProposal('compound:42')
    expect(p).toBeDefined()
    expect(p!.protocol).toBe('compound')
    expect(p!.stage).toBe('onchain_vote')
    expect(p!.title).toBe('Set WETH LTV to 80%')
  })

  it('updates existing proposal stage', () => {
    upsertProposal({
      id: 'compound:42',
      protocol: 'compound',
      stage: 'timelock',
    })
    const p = getProposal('compound:42')
    expect(p!.stage).toBe('timelock')
    expect(p!.title).toBe('Set WETH LTV to 80%') // preserved
  })

  it('getActiveProposals excludes executed', () => {
    upsertProposal({ id: 'aave:10', protocol: 'aave', stage: 'executed' })
    upsertProposal({ id: 'aave:11', protocol: 'aave', stage: 'onchain_vote' })
    const active = getActiveProposals()
    expect(active.some((p) => p.id === 'aave:10')).toBe(false)
    expect(active.some((p) => p.id === 'aave:11')).toBe(true)
  })
})

describe('positions', () => {
  it('creates and retrieves a position', () => {
    upsertPosition({
      id: 'dydx:AAVE-USD',
      protocol: 'dydx',
      type: 'perp',
      asset: 'AAVE',
      size: '10.5',
      entryPrice: '95.20',
      currentPrice: '96.50',
      unrealizedPnl: '13.65',
    })
    const positions = getPositions('dydx')
    expect(positions.length).toBeGreaterThan(0)
    const p = positions.find((pos) => pos.id === 'dydx:AAVE-USD')
    expect(p).toBeDefined()
    expect(p!.asset).toBe('AAVE')
    expect(p!.size).toBe('10.5')
  })

  it('updates an existing position', () => {
    upsertPosition({
      id: 'dydx:AAVE-USD',
      protocol: 'dydx',
      type: 'perp',
      asset: 'AAVE',
      size: '5.0',
      entryPrice: '95.20',
      currentPrice: '98.00',
      unrealizedPnl: '14.00',
    })
    const positions = getPositions('dydx')
    const p = positions.find((pos) => pos.id === 'dydx:AAVE-USD')
    expect(p!.size).toBe('5.0')
  })

  it('deletes a position', () => {
    deletePosition('dydx:AAVE-USD')
    const positions = getPositions('dydx')
    expect(positions.find((pos) => pos.id === 'dydx:AAVE-USD')).toBeUndefined()
  })
})

describe('alert log', () => {
  it('logs an alert without error', () => {
    expect(() => {
      logAlert({
        type: 'proposal_detected',
        severity: 'info',
        channel: 'telegram',
        title: 'New Proposal',
        message: 'Compound #42 detected',
        metadata: { proposalId: '42' },
      })
    }).not.toThrow()
  })
})

describe('forum cursors', () => {
  it('returns 0 for unknown forum', () => {
    expect(getForumCursor('https://example.com')).toBe(0)
  })

  it('sets and gets forum cursor', () => {
    setForumCursor('https://governance.aave.com', 5000)
    expect(getForumCursor('https://governance.aave.com')).toBe(5000)
  })
})

describe('snapshot cursors', () => {
  it('returns null for unknown space', () => {
    expect(getSnapshotCursor('unknown.eth')).toBeNull()
  })

  it('sets and gets snapshot cursor', () => {
    setSnapshotCursor('aave.eth', 'proposal-abc-123')
    expect(getSnapshotCursor('aave.eth')).toBe('proposal-abc-123')
  })
})
