/**
 * Tests for proposal classifier — maps decoded actions to impact categories.
 */
import { describe, it, expect } from 'vitest'
import {
  classifyAction,
  classifyProposal,
  getImpactCategories,
} from '../../src/analysis/proposalClassifier.js'
import type { DecodedAction } from '../../src/types/governance.js'

describe('classifyAction', () => {
  it('classifies configureReserveAsCollateral as ltv_change', () => {
    const action: DecodedAction = {
      target: '0x64b761D848206f447Fe2dd461b0c635Ec39EbB27',
      signature: 'configureReserveAsCollateral(address,uint256,uint256,uint256)',
      params: { param0: '0xWETH', param1: '8000', param2: '8250', param3: '10500' },
      value: 0n,
    }
    expect(classifyAction(action)).toBe('ltv_change')
  })

  it('classifies setBorrowCap as borrow_cap_change', () => {
    const action: DecodedAction = {
      target: '0x64b761D848206f447Fe2dd461b0c635Ec39EbB27',
      signature: 'setBorrowCap(address,uint256)',
      params: { param0: '0xWETH', param1: '50000' },
      value: 0n,
    }
    expect(classifyAction(action)).toBe('borrow_cap_change')
  })

  it('classifies setSupplyCap as supply_cap_change', () => {
    const action: DecodedAction = {
      target: '0x64b761D848206f447Fe2dd461b0c635Ec39EbB27',
      signature: 'setSupplyCap(address,uint256)',
      params: {},
      value: 0n,
    }
    expect(classifyAction(action)).toBe('supply_cap_change')
  })

  it('classifies setReserveFreeze as reserve_freeze', () => {
    const action: DecodedAction = {
      target: '0x64b761D848206f447Fe2dd461b0c635Ec39EbB27',
      signature: 'setReserveFreeze(address,bool)',
      params: { param0: '0xWETH', param1: true },
      value: 0n,
    }
    expect(classifyAction(action)).toBe('reserve_freeze')
  })

  it('classifies setDebtCeiling as debt_ceiling_change', () => {
    const action: DecodedAction = {
      target: '0x64b761D848206f447Fe2dd461b0c635Ec39EbB27',
      signature: 'setDebtCeiling(address,uint256)',
      params: {},
      value: 0n,
    }
    expect(classifyAction(action)).toBe('debt_ceiling_change')
  })

  it('classifies Compound updateAssetBorrowCollateralFactor as ltv_change', () => {
    const action: DecodedAction = {
      target: '0xCompoundConfigurator',
      signature: 'updateAssetBorrowCollateralFactor(address,address,uint64)',
      params: {},
      value: 0n,
    }
    expect(classifyAction(action)).toBe('ltv_change')
  })

  it('classifies Compound updateAssetSupplyCap as supply_cap_change', () => {
    const action: DecodedAction = {
      target: '0xCompoundConfigurator',
      signature: 'updateAssetSupplyCap(address,address,uint128)',
      params: {},
      value: 0n,
    }
    expect(classifyAction(action)).toBe('supply_cap_change')
  })

  it('classifies MakerDAO setIlkDebtCeiling as debt_ceiling_change', () => {
    const action: DecodedAction = {
      target: '0xSpell',
      signature: 'DssExecLib.setIlkDebtCeiling(bytes32,uint256)',
      params: {},
      value: 0n,
    }
    expect(classifyAction(action)).toBe('debt_ceiling_change')
  })

  it('classifies MakerDAO setDSR as dsr_change', () => {
    const action: DecodedAction = {
      target: '0xSpell',
      signature: 'DssExecLib.setDSR(uint256)',
      params: {},
      value: 0n,
    }
    expect(classifyAction(action)).toBe('dsr_change')
  })

  it('classifies unknown functions as other', () => {
    const action: DecodedAction = {
      target: '0xABC',
      signature: 'someRandomFunction(uint256)',
      params: {},
      value: 0n,
    }
    expect(classifyAction(action)).toBe('other')
  })
})

describe('classifyProposal', () => {
  it('generates impacts for multiple actions', () => {
    const actions: DecodedAction[] = [
      {
        target: '0xPoolConfigurator',
        signature: 'setBorrowCap(address,uint256)',
        params: { param0: '0xWETH', param1: '50000' },
        value: 0n,
      },
      {
        target: '0xPoolConfigurator',
        signature: 'setSupplyCap(address,uint256)',
        params: { param0: '0xWBTC', param1: '10000' },
        value: 0n,
      },
      {
        target: '0xOther',
        signature: 'unknownFunc()',
        params: {},
        value: 0n,
      },
    ]

    const impacts = classifyProposal(actions)
    expect(impacts).toHaveLength(2) // unknownFunc is excluded
    expect(impacts[0].category).toBe('borrow_cap_change')
    expect(impacts[1].category).toBe('supply_cap_change')
  })

  it('assigns severity correctly', () => {
    const actions: DecodedAction[] = [
      {
        target: '0x',
        signature: 'setReserveFreeze(address,bool)',
        params: { param0: '0xWETH' },
        value: 0n,
      },
    ]
    const impacts = classifyProposal(actions)
    expect(impacts[0].severity).toBe('critical')
  })
})

describe('getImpactCategories', () => {
  it('returns unique categories', () => {
    const actions: DecodedAction[] = [
      { target: '0x', signature: 'setBorrowCap(address,uint256)', params: {}, value: 0n },
      { target: '0x', signature: 'setBorrowCap(address,uint256)', params: {}, value: 0n },
      { target: '0x', signature: 'setSupplyCap(address,uint256)', params: {}, value: 0n },
    ]
    const categories = getImpactCategories(actions)
    expect(categories).toHaveLength(2)
    expect(categories).toContain('borrow_cap_change')
    expect(categories).toContain('supply_cap_change')
  })
})
