/**
 * Tests for event signatures and topic0 hashes.
 */
import { describe, it, expect } from 'vitest'
import {
  GOVERNOR_BRAVO_EVENTS,
  MAKER_DSNOTE_SELECTORS,
  MAKER_DSNOTE_TOPICS,
  DELEGATION_EVENTS,
} from '../../src/config/events.js'

describe('Governor Bravo events', () => {
  it('ProposalCreated has correct topic0', () => {
    expect(GOVERNOR_BRAVO_EVENTS.ProposalCreated.topic0).toBe(
      '0x7d84a6263ae0d98d3329bd7b46bb4e8d6f98cd35a7adb45c274c8b7fd5ebd5e0',
    )
  })

  it('VoteCast has correct topic0', () => {
    expect(GOVERNOR_BRAVO_EVENTS.VoteCast.topic0).toBe(
      '0xb8e138887d0aa13bab447e82de9d5c1777041ecd21ca36ba824ff1e6c07ddda4',
    )
  })

  it('ProposalQueued has correct topic0', () => {
    expect(GOVERNOR_BRAVO_EVENTS.ProposalQueued.topic0).toBe(
      '0x9a2e42fd6722813d69113e7d0079d3d940171428df7373df9c7f7617cfda2892',
    )
  })

  it('ProposalExecuted has correct topic0', () => {
    expect(GOVERNOR_BRAVO_EVENTS.ProposalExecuted.topic0).toBe(
      '0x712ae1383f79ac853f8d882153778e0260ef8f03b504e2a0b87b6d0a92311534',
    )
  })

  it('all topic0 are 66-char hex strings', () => {
    for (const ev of Object.values(GOVERNOR_BRAVO_EVENTS)) {
      expect(ev.topic0).toMatch(/^0x[0-9a-f]{64}$/)
    }
  })
})

describe('Maker DSNote selectors', () => {
  it('has all 5 selectors', () => {
    expect(Object.keys(MAKER_DSNOTE_SELECTORS)).toHaveLength(5)
  })

  it('selectors are 4-byte hex', () => {
    for (const sel of Object.values(MAKER_DSNOTE_SELECTORS)) {
      expect(sel).toMatch(/^0x[0-9a-f]{8}$/)
    }
  })

  it('lock selector is 0xdd467064', () => {
    expect(MAKER_DSNOTE_SELECTORS.lock).toBe('0xdd467064')
  })

  it('MAKER_DSNOTE_TOPICS has padded versions', () => {
    expect(MAKER_DSNOTE_TOPICS).toHaveLength(5)
    for (const topic of MAKER_DSNOTE_TOPICS) {
      expect(topic).toHaveLength(66) // 0x + 64 hex chars
      expect(topic).toMatch(/^0x[0-9a-f]{8}0{56}$/)
    }
  })
})

describe('Delegation events', () => {
  it('DelegateChanged has correct topic0', () => {
    expect(DELEGATION_EVENTS.DelegateChanged.topic0).toBe(
      '0x3134e8a2e6d97e929a7e54011ea5485d7d196dd5f0ba4d4ef95803e8e3fc257f',
    )
  })

  it('DelegateVotesChanged has a topic0', () => {
    expect(DELEGATION_EVENTS.DelegateVotesChanged.topic0).toMatch(/^0x[0-9a-fA-F]{64}$/)
  })
})
