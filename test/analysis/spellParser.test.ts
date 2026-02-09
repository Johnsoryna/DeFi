/**
 * Tests for MakerDAO spell source parser.
 */
import { describe, it, expect } from 'vitest'
import { parseSpellSource, getDssExecLibCategory } from '../../src/analysis/spellParser.js'

const SAMPLE_SPELL_SOURCE = `
pragma solidity 0.8.16;

contract DssSpell {
    function actions() internal override {
        // Increase debt ceiling
        DssExecLib.setIlkDebtCeiling("ETH-A", 500 * MILLION);
        
        // Update stability fee
        DssExecLib.setIlkStabilityFee("ETH-A", FIVE_PCT_RATE, true);
        
        // Set DSR
        DssExecLib.setDSR(THREE_PT_THREE_THREE_PCT_RATE, true);
        
        // Set liquidation ratio
        DssExecLib.setIlkLiquidationRatio("WBTC-A", 14500);
        
        // AutoLine parameters
        DssExecLib.setIlkAutoLineParameters("WSTETH-A", 500 * MILLION, 50 * MILLION, 8 hours);
    }
}
`

describe('parseSpellSource', () => {
  it('extracts DssExecLib calls from spell source', () => {
    const actions = parseSpellSource(SAMPLE_SPELL_SOURCE, '0xSpell')
    
    expect(actions.length).toBeGreaterThanOrEqual(5)
    
    // Check setIlkDebtCeiling
    const debtCeiling = actions.find(a => 
      a.params.functionName === 'setIlkDebtCeiling'
    )
    expect(debtCeiling).toBeDefined()
    expect(debtCeiling!.params.ilk).toBe('"ETH-A"')
    expect(debtCeiling!.params.debtCeiling).toBe('500 * MILLION')

    // Check setDSR
    const dsr = actions.find(a => a.params.functionName === 'setDSR')
    expect(dsr).toBeDefined()
    expect(dsr!.params.dsr).toBe('THREE_PT_THREE_THREE_PCT_RATE')

    // Check setIlkStabilityFee
    const sf = actions.find(a => a.params.functionName === 'setIlkStabilityFee')
    expect(sf).toBeDefined()
    expect(sf!.params.ilk).toBe('"ETH-A"')

    // Check setIlkLiquidationRatio
    const lr = actions.find(a => a.params.functionName === 'setIlkLiquidationRatio')
    expect(lr).toBeDefined()
    expect(lr!.params.liquidationRatio).toBe('14500')

    // Check setIlkAutoLineParameters
    const auto = actions.find(a => a.params.functionName === 'setIlkAutoLineParameters')
    expect(auto).toBeDefined()
    expect(auto!.params.ilk).toBe('"WSTETH-A"')
  })
})

describe('getDssExecLibCategory', () => {
  it('maps setIlkDebtCeiling → debt_ceiling_change', () => {
    expect(getDssExecLibCategory('setIlkDebtCeiling')).toBe('debt_ceiling_change')
  })

  it('maps setIlkStabilityFee → stability_fee_change', () => {
    expect(getDssExecLibCategory('setIlkStabilityFee')).toBe('stability_fee_change')
  })

  it('maps setDSR → dsr_change', () => {
    expect(getDssExecLibCategory('setDSR')).toBe('dsr_change')
  })

  it('maps setIlkLiquidationRatio → liquidation_threshold_change', () => {
    expect(getDssExecLibCategory('setIlkLiquidationRatio')).toBe('liquidation_threshold_change')
  })

  it('maps unknown → other', () => {
    expect(getDssExecLibCategory('unknownFunction')).toBe('other')
  })
})
