/**
 * Tests for contract addresses and config constants — sanity checks.
 */
import { describe, it, expect } from 'vitest'
import {
  GOVERNANCE,
  AAVE_V3,
  COMPOUND_V3,
  TOKENS,
  BINANCE,
  APIS,
  FORUMS,
  SNAPSHOT_SPACES,
  DELEGATION_TOKEN_ADDRESSES,
} from '../../src/config/addresses.js'

describe('contract addresses', () => {
  it('all governance addresses are valid hex', () => {
    for (const addr of Object.values(GOVERNANCE)) {
      expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/)
    }
  })

  it('all Aave V3 addresses are valid hex', () => {
    for (const addr of Object.values(AAVE_V3)) {
      expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/)
    }
  })

  it('all Compound V3 addresses are valid hex', () => {
    for (const addr of Object.values(COMPOUND_V3)) {
      expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/)
    }
  })

  it('all token addresses are valid hex', () => {
    for (const addr of Object.values(TOKENS)) {
      expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/)
    }
  })

  it('expected governance tokens exist', () => {
    expect(TOKENS.COMP).toBeDefined()
    expect(TOKENS.AAVE).toBeDefined()
    expect(TOKENS.UNI).toBeDefined()
    expect(TOKENS.MKR).toBeDefined()
    expect(TOKENS.SKY).toBeDefined()
    // Curated protocol tokens
    expect(TOKENS.LDO).toBeDefined()
    expect(TOKENS.CRV).toBeDefined()
    expect(TOKENS.SNX).toBeDefined()
    expect(TOKENS.ARB).toBeDefined()
    expect(TOKENS.OP).toBeDefined()
    // New protocol tokens
    expect(TOKENS.DYDX).toBeDefined()
    expect(TOKENS.ENA).toBeDefined()
    expect(TOKENS.EIGEN).toBeDefined()
    // Newest protocol tokens (Ethereum mainnet)
    expect(TOKENS.POL).toBeDefined()
    expect(TOKENS.STRK).toBeDefined()
    expect(TOKENS.MORPHO).toBeDefined()
    expect(TOKENS.MNT).toBeDefined()
  })
})

describe('API endpoints', () => {
  it('Binance Futures endpoints are HTTPS/WSS', () => {
    expect(BINANCE.futuresRest).toMatch(/^https:\/\//)
    expect(BINANCE.futuresWs).toMatch(/^wss:\/\//)
  })

  it('external API URLs are well-formed', () => {
    expect(APIS.snapshotGraphql).toMatch(/^https:\/\//)
    expect(APIS.defiLlamaProtocols).toMatch(/^https:\/\//)
  })

  it('forum URLs are HTTPS', () => {
    // All forum URLs should be HTTPS
    for (const [, url] of Object.entries(FORUMS)) {
      expect(url).toMatch(/^https:\/\//)
    }
    // Spot-check key protocols
    expect(FORUMS.aave).toContain('aave')
    expect(FORUMS.compound).toContain('comp')
    expect(FORUMS.uniswap).toContain('uniswap')
    expect(FORUMS.cosmos).toContain('cosmos')
  })
})

describe('derived constants', () => {
  it('DELEGATION_TOKEN_ADDRESSES has expected entries', () => {
    // At least 5 profitable governance tokens with delegation support
    expect(DELEGATION_TOKEN_ADDRESSES.length).toBeGreaterThanOrEqual(5)
  })

  it('SNAPSHOT_SPACES has expected entries', () => {
    expect(SNAPSHOT_SPACES.length).toBeGreaterThanOrEqual(14)
    // Core profitable spaces must be present
    expect(SNAPSHOT_SPACES).toContain('aavedao.eth')
    expect(SNAPSHOT_SPACES).toContain('compound-governance.eth')
  })
})
