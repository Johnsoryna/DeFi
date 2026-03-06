import { describe, it, expect } from 'vitest'
import { roundStep } from '../../src/clients/binance.js'

describe('binance roundStep', () => {
  it('floors by default', () => {
    expect(roundStep(1.239, '0.01')).toBe('1.23')
  })

  it('supports round-to-nearest mode', () => {
    expect(roundStep(1.235, '0.01', 'round')).toBe('1.24')
  })

  it('avoids floating residue on 0.1 steps in round mode', () => {
    expect(roundStep(1200.8, '0.1', 'round')).toBe('1200.8')
  })
})
