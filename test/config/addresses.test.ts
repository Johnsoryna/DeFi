/**
 * Tests for contract addresses and config constants — sanity checks.
 */
import { describe, it, expect } from 'vitest'
import {
  GOVERNANCE,
  AAVE_V3,
  COMPOUND_V3,
  TOKENS,
  DYDX,
  APIS,
  FORUMS,
  SNAPSHOT_SPACES,
  GOVERNOR_BRAVO_ADDRESSES,
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
  })
})

describe('API endpoints', () => {
  it('dYdX endpoints are HTTPS/WSS', () => {
    expect(DYDX.indexerRest).toMatch(/^https:\/\//)
    expect(DYDX.indexerWs).toMatch(/^wss:\/\//)
    expect(DYDX.chainRpc).toMatch(/^https:\/\//)
  })

  it('external API URLs are well-formed', () => {
    expect(APIS.snapshotGraphql).toMatch(/^https:\/\//)
    expect(APIS.tallyGraphql).toMatch(/^https:\/\//)
    expect(APIS.cowswap).toMatch(/^https:\/\//)
    expect(APIS.pendleApi).toMatch(/^https:\/\//)
    expect(APIS.defiLlamaProtocols).toMatch(/^https:\/\//)
  })

  it('forum URLs are HTTPS', () => {
    expect(FORUMS.aave).toMatch(/^https:\/\//)
    expect(FORUMS.compound).toMatch(/^https:\/\//)
    expect(FORUMS.maker).toMatch(/^https:\/\//)
  })
})

describe('derived constants', () => {
  it('GOVERNOR_BRAVO_ADDRESSES has 2 entries', () => {
    expect(GOVERNOR_BRAVO_ADDRESSES).toHaveLength(2)
  })

  it('DELEGATION_TOKEN_ADDRESSES has 5 entries', () => {
    expect(DELEGATION_TOKEN_ADDRESSES).toHaveLength(5)
  })

  it('SNAPSHOT_SPACES has 3 entries', () => {
    expect(SNAPSHOT_SPACES).toHaveLength(3)
  })
})
