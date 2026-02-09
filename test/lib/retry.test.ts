/**
 * Tests for retry / rate-limit utility.
 */
import { describe, it, expect, vi } from 'vitest'
import { withRetry, rateLimited, sleep } from '../../src/lib/retry.js'

describe('withRetry', () => {
  it('returns on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await withRetry(fn, 'test')
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledOnce()
  })

  it('retries on failure then succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockResolvedValue('ok')

    const result = await withRetry(fn, 'test', { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50 })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('throws after all retries exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fail'))

    await expect(
      withRetry(fn, 'test', { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50 }),
    ).rejects.toThrow('always fail')

    expect(fn).toHaveBeenCalledTimes(3) // initial + 2 retries
  })

  it('respects shouldRetry predicate', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('non-retryable'))

    await expect(
      withRetry(fn, 'test', {
        maxRetries: 3,
        baseDelayMs: 10,
        maxDelayMs: 50,
        shouldRetry: () => false,
      }),
    ).rejects.toThrow('non-retryable')

    expect(fn).toHaveBeenCalledOnce() // no retries
  })
})

describe('rateLimited', () => {
  it('enforces minimum interval between calls', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const limited = rateLimited(fn, 100)

    const start = Date.now()
    await limited()
    await limited()
    const elapsed = Date.now() - start

    expect(elapsed).toBeGreaterThanOrEqual(90) // ~100ms gap
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

describe('sleep', () => {
  it('waits approximately the given duration', async () => {
    const start = Date.now()
    await sleep(50)
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(40)
    expect(elapsed).toBeLessThan(200)
  })
})
