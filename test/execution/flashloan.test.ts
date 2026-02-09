/**
 * Tests for flash loan calldata builder.
 */
import { describe, it, expect } from 'vitest'
import {
  buildBalancerFlashLoanCalldata,
  buildAaveFlashLoanCalldata,
  encodeRecursiveLeverageData,
} from '../../src/execution/flashloan.js'
import { BALANCER, AAVE_V3 } from '../../src/config/addresses.js'

describe('buildBalancerFlashLoanCalldata', () => {
  it('returns correct target address (Balancer Vault)', () => {
    const result = buildBalancerFlashLoanCalldata({
      recipient: '0x1111111111111111111111111111111111111111',
      tokens: ['0x2222222222222222222222222222222222222222'],
      amounts: [1000000n],
      userData: '0x',
    })

    expect(result.to.toLowerCase()).toBe(BALANCER.v2Vault.toLowerCase())
  })

  it('generates non-empty calldata', () => {
    const result = buildBalancerFlashLoanCalldata({
      recipient: '0x1111111111111111111111111111111111111111',
      tokens: ['0x2222222222222222222222222222222222222222'],
      amounts: [1000000n],
      userData: '0x',
    })

    expect(result.data).toMatch(/^0x/)
    expect(result.data.length).toBeGreaterThan(10)
  })

  it('starts with flashLoan selector', () => {
    const result = buildBalancerFlashLoanCalldata({
      recipient: '0x1111111111111111111111111111111111111111',
      tokens: [],
      amounts: [],
      userData: '0x',
    })

    // flashLoan(address,address[],uint256[],bytes) selector
    expect(result.data.slice(0, 10)).toBe('0x5c38449e')
  })
})

describe('buildAaveFlashLoanCalldata', () => {
  it('returns correct target address (Aave Pool)', () => {
    const result = buildAaveFlashLoanCalldata({
      receiver: '0x1111111111111111111111111111111111111111',
      asset: '0x2222222222222222222222222222222222222222',
      amount: 1000000n,
      userData: '0x',
    })

    expect(result.to.toLowerCase()).toBe(AAVE_V3.pool.toLowerCase())
  })

  it('generates non-empty calldata', () => {
    const result = buildAaveFlashLoanCalldata({
      receiver: '0x1111111111111111111111111111111111111111',
      asset: '0x2222222222222222222222222222222222222222',
      amount: 1000000n,
      userData: '0x',
    })

    expect(result.data).toMatch(/^0x/)
    expect(result.data.length).toBeGreaterThan(10)
  })
})

describe('encodeRecursiveLeverageData', () => {
  it('encodes recursive leverage params as hex', () => {
    const data = encodeRecursiveLeverageData({
      asset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      flashBorrowAmount: 10n ** 18n,
      leverageLoops: 3,
      borrowRatioBps: 7000,
    })

    expect(data).toMatch(/^0x/)
    expect(data.length).toBeGreaterThan(10)
  })
})
