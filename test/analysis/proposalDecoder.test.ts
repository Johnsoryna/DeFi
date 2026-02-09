/**
 * Tests for proposal decoder — Governor Bravo calldata decoding.
 */
import { describe, it, expect } from 'vitest'
import { decodeGovernorBravoActions } from '../../src/analysis/proposalDecoder.js'
import type { ProposalCreatedEvent } from '../../src/types/governance.js'

describe('decodeGovernorBravoActions', () => {
  it('decodes a proposal with setBorrowCap signature', () => {
    const event: ProposalCreatedEvent = {
      type: 'proposal_created',
      protocol: 'compound',
      blockNumber: 100n,
      transactionHash: '0xabc',
      logIndex: 0,
      removed: false,
      proposalId: 42n,
      proposer: '0x123',
      targets: ['0x64b761D848206f447Fe2dd461b0c635Ec39EbB27'],
      values: [0n],
      signatures: ['setBorrowCap(address,uint256)'],
      calldatas: [
        // ABI-encoded (address, uint256) without selector
        '0x000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc20000000000000000000000000000000000000000000000000000000000007530',
      ],
      description: 'Set WETH borrow cap to 30000',
    }

    const actions = decodeGovernorBravoActions(event)
    expect(actions).toHaveLength(1)
    expect(actions[0].target).toBe('0x64b761D848206f447Fe2dd461b0c635Ec39EbB27')
    expect(actions[0].signature).toBe('setBorrowCap(address,uint256)')
    expect(actions[0].value).toBe(0n)
  })

  it('handles proposals with no signature (raw calldata)', () => {
    const event: ProposalCreatedEvent = {
      type: 'proposal_created',
      protocol: 'compound',
      blockNumber: 100n,
      transactionHash: '0xdef',
      logIndex: 0,
      removed: false,
      proposalId: 43n,
      proposer: '0x456',
      targets: ['0xSomeContract'],
      values: [0n],
      signatures: [''],
      calldatas: ['0x12345678'],
      description: 'Raw calldata proposal',
    }

    const actions = decodeGovernorBravoActions(event)
    expect(actions).toHaveLength(1)
    expect(actions[0].params.raw).toBe('0x12345678')
  })

  it('handles multi-action proposals', () => {
    const event: ProposalCreatedEvent = {
      type: 'proposal_created',
      protocol: 'uniswap',
      blockNumber: 200n,
      transactionHash: '0x999',
      logIndex: 0,
      removed: false,
      proposalId: 10n,
      proposer: '0xAAA',
      targets: ['0xTarget1', '0xTarget2', '0xTarget3'],
      values: [0n, 100n, 0n],
      signatures: [
        'setSupplyCap(address,uint256)',
        '', // raw calldata
        'setBorrowCap(address,uint256)',
      ],
      calldatas: ['0x00', '0xabcdef', '0x00'],
      description: 'Multi-action proposal',
    }

    const actions = decodeGovernorBravoActions(event)
    expect(actions).toHaveLength(3)
    expect(actions[0].signature).toBe('setSupplyCap(address,uint256)')
    expect(actions[1].signature).toBe('')
    expect(actions[1].value).toBe(100n)
    expect(actions[2].signature).toBe('setBorrowCap(address,uint256)')
  })
})
