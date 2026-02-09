/**
 * Tests for typed event bus.
 */
import { describe, it, expect, vi } from 'vitest'
import { eventBus } from '../../src/lib/eventBus.js'

describe('eventBus', () => {
  it('emits and receives governance:proposal events', () => {
    const handler = vi.fn()
    eventBus.on('governance:proposal', handler)

    const mockEvent = {
      type: 'proposal_created' as const,
      protocol: 'compound' as const,
      blockNumber: 100n,
      transactionHash: '0xabc',
      logIndex: 0,
      removed: false,
      proposalId: 42n,
      proposer: '0x123',
      targets: [],
      values: [],
      signatures: [],
      calldatas: [],
      description: 'Test proposal',
    }

    eventBus.emit('governance:proposal', mockEvent)
    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(mockEvent)

    eventBus.off('governance:proposal', handler)
  })

  it('emits price:update events', () => {
    const handler = vi.fn()
    eventBus.on('price:update', handler)

    eventBus.emit('price:update', { asset: 'AAVE', price: '95.5', source: 'dydx' })
    expect(handler).toHaveBeenCalledWith({ asset: 'AAVE', price: '95.5', source: 'dydx' })

    eventBus.off('price:update', handler)
  })

  it('emits alert:send events', () => {
    const handler = vi.fn()
    eventBus.on('alert:send', handler)

    const alert = {
      id: 'test-1',
      type: 'system_health' as const,
      severity: 'info' as const,
      channel: 'telegram' as const,
      title: 'Test',
      message: 'Hello',
      timestamp: Date.now(),
    }

    eventBus.emit('alert:send', alert)
    expect(handler).toHaveBeenCalledOnce()

    eventBus.off('alert:send', handler)
  })

  it('does not fire after off()', () => {
    const handler = vi.fn()
    eventBus.on('system:shutdown', handler)
    eventBus.off('system:shutdown', handler)

    eventBus.emit('system:shutdown', { reason: 'test' })
    expect(handler).not.toHaveBeenCalled()
  })
})
