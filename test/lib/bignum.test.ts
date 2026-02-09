/**
 * Tests for BigNum / DeFi math helpers.
 */
import { describe, it, expect } from 'vitest'
import {
  RAY, WAD, BPS,
  rayToDecimal,
  wadToDecimal,
  bpsToPercent,
  percentToBps,
  rayRateToApy,
  computeHealthFactor,
  simulateHfAfterLtChange,
  hfLiquidationThreshold,
  formatTokenAmount,
  parseTokenAmount,
  decodeAaveReserveConfig,
} from '../../src/lib/bignum.js'

describe('bignum constants', () => {
  it('RAY = 1e27', () => {
    expect(RAY).toBe(10n ** 27n)
  })
  it('WAD = 1e18', () => {
    expect(WAD).toBe(10n ** 18n)
  })
  it('BPS = 10000', () => {
    expect(BPS).toBe(10000n)
  })
})

describe('rayToDecimal', () => {
  it('converts 1 RAY to "1.000000"', () => {
    expect(rayToDecimal(RAY)).toBe('1.000000')
  })
  it('converts 0.5 RAY correctly', () => {
    const half = RAY / 2n
    expect(rayToDecimal(half)).toBe('0.500000')
  })
  it('converts 2.5 RAY correctly', () => {
    const val = RAY * 2n + RAY / 2n
    expect(rayToDecimal(val)).toBe('2.500000')
  })
})

describe('wadToDecimal', () => {
  it('converts 1 WAD to "1.000000"', () => {
    expect(wadToDecimal(WAD)).toBe('1.000000')
  })
  it('converts 1000 WAD correctly', () => {
    expect(wadToDecimal(WAD * 1000n)).toBe('1000.000000')
  })
})

describe('bpsToPercent', () => {
  it('8250 bps = 82.5%', () => {
    expect(bpsToPercent(8250)).toBe(82.5)
  })
  it('10000 bps = 100%', () => {
    expect(bpsToPercent(10000)).toBe(100)
  })
  it('0 bps = 0%', () => {
    expect(bpsToPercent(0)).toBe(0)
  })
})

describe('percentToBps', () => {
  it('82.5% = 8250n', () => {
    expect(percentToBps(82.5)).toBe(8250n)
  })
  it('100% = 10000n', () => {
    expect(percentToBps(100)).toBe(10000n)
  })
})

describe('computeHealthFactor', () => {
  it('returns Infinity when no debt', () => {
    const hf = computeHealthFactor(1000n, 0n, 8000n)
    expect(hf).toBe(Infinity)
  })

  it('computes HF = 1.0 at liquidation edge', () => {
    // collateral=1000, debt=800, LT=80% → HF = (1000*0.8)/800 = 1.0
    const hf = computeHealthFactor(1000n, 800n, 8000n)
    expect(hf).toBeCloseTo(1.0, 2)
  })

  it('computes HF > 1 for healthy position', () => {
    // collateral=2000, debt=800, LT=80% → HF = (2000*0.8)/800 = 2.0
    const hf = computeHealthFactor(2000n, 800n, 8000n)
    expect(hf).toBeCloseTo(2.0, 2)
  })

  it('computes HF < 1 for liquidatable position', () => {
    // collateral=900, debt=800, LT=80% → HF = (900*0.8)/800 = 0.9
    const hf = computeHealthFactor(900n, 800n, 8000n)
    expect(hf).toBeCloseTo(0.9, 2)
  })
})

describe('simulateHfAfterLtChange', () => {
  it('LT decrease from 82.5% to 80% scales HF down', () => {
    const newHf = simulateHfAfterLtChange(1.1, 8250, 8000)
    // 1.1 * (8000/8250) = 1.0666...
    expect(newHf).toBeCloseTo(1.0667, 3)
  })

  it('LT increase from 80% to 85% scales HF up', () => {
    const newHf = simulateHfAfterLtChange(1.0, 8000, 8500)
    // 1.0 * (8500/8000) = 1.0625
    expect(newHf).toBeCloseTo(1.0625, 3)
  })
})

describe('hfLiquidationThreshold', () => {
  it('LT 82.5% → 80%: threshold = 82.5/80 = 1.03125', () => {
    const threshold = hfLiquidationThreshold(8250, 8000)
    expect(threshold).toBeCloseTo(1.03125, 4)
  })

  it('LT 80% → 75%: threshold = 80/75 = 1.0667', () => {
    const threshold = hfLiquidationThreshold(8000, 7500)
    expect(threshold).toBeCloseTo(1.0667, 3)
  })
})

describe('formatTokenAmount', () => {
  it('formats 1e18 wei as 1.0000', () => {
    expect(formatTokenAmount(10n ** 18n, 18)).toBe('1.0000')
  })

  it('formats 1.5e6 USDC as 1.5000', () => {
    expect(formatTokenAmount(1_500_000n, 6)).toBe('1.5000')
  })

  it('formats 0 correctly', () => {
    expect(formatTokenAmount(0n, 18)).toBe('0.0000')
  })
})

describe('parseTokenAmount', () => {
  it('parses "1.5" with 18 decimals', () => {
    expect(parseTokenAmount('1.5', 18)).toBe(1_500_000_000_000_000_000n)
  })

  it('parses "100" with 6 decimals', () => {
    expect(parseTokenAmount('100', 6)).toBe(100_000_000n)
  })

  it('parses "0.001" with 18 decimals', () => {
    expect(parseTokenAmount('0.001', 18)).toBe(1_000_000_000_000_000n)
  })
})

describe('decodeAaveReserveConfig', () => {
  it('decodes a realistic Aave reserve config bitmap', () => {
    // Build a config bitmap:
    // LTV = 8000 (80%), LT = 8250 (82.5%), LB = 10500 (5% bonus), decimals = 18
    // active=1, frozen=0, borrowing=1, paused=0
    // reserveFactor = 1000 (10%)
    let cfg = BigInt(8000)                      // bits 0-15: LTV
    cfg |= BigInt(8250) << 16n                  // bits 16-31: liquidation threshold
    cfg |= BigInt(10500) << 32n                 // bits 32-47: liquidation bonus
    cfg |= BigInt(18) << 48n                    // bits 48-55: decimals
    cfg |= 1n << 56n                            // bit 56: active
    cfg |= 0n << 57n                            // bit 57: frozen
    cfg |= 1n << 58n                            // bit 58: borrowing enabled
    cfg |= 0n << 60n                            // bit 60: paused
    cfg |= BigInt(1000) << 64n                  // bits 64-79: reserve factor
    cfg |= BigInt(50000) << 80n                 // bits 80-115: borrow cap
    cfg |= BigInt(100000) << 116n               // bits 116-151: supply cap

    const decoded = decodeAaveReserveConfig(cfg)
    expect(decoded.ltv).toBe(8000)
    expect(decoded.liquidationThreshold).toBe(8250)
    expect(decoded.liquidationBonus).toBe(10500)
    expect(decoded.decimals).toBe(18)
    expect(decoded.isActive).toBe(true)
    expect(decoded.isFrozen).toBe(false)
    expect(decoded.isBorrowingEnabled).toBe(true)
    expect(decoded.isPaused).toBe(false)
    expect(decoded.reserveFactor).toBe(1000)
    expect(decoded.borrowCap).toBe(50000n)
    expect(decoded.supplyCap).toBe(100000n)
  })
})
