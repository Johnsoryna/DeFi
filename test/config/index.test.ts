import { afterEach, describe, expect, it, vi } from 'vitest'

const ORIGINAL_ENV = { ...process.env }

async function loadConfigWithEnv(overrides: Record<string, string | undefined>) {
  process.env = { ...ORIGINAL_ENV }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.resetModules()
  return import('../../src/config/index.js')
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.resetModules()
})

describe('config/index', () => {
  it('prioritizes explicit Alchemy URLs over API key-derived URLs', async () => {
    const mod = await loadConfigWithEnv({
      ALCHEMY_API_KEY: 'x'.repeat(24),
      ALCHEMY_RPC_URL: 'https://eth-mainnet.g.alchemy.com/v2/custom-http',
      ALCHEMY_WSS_URL: 'wss://eth-mainnet.g.alchemy.com/v2/custom-wss',
    })

    expect(mod.getAlchemyHttpUrl()).toBe('https://eth-mainnet.g.alchemy.com/v2/custom-http')
    expect(mod.getAlchemyWssUrl()).toBe('wss://eth-mainnet.g.alchemy.com/v2/custom-wss')
  })

  it('builds Alchemy URLs from API key when explicit URLs are absent', async () => {
    const apiKey = 'k'.repeat(24)
    const mod = await loadConfigWithEnv({
      ALCHEMY_API_KEY: apiKey,
      ALCHEMY_RPC_URL: undefined,
      ALCHEMY_WSS_URL: undefined,
    })

    expect(mod.getAlchemyHttpUrl()).toBe(`https://eth-mainnet.g.alchemy.com/v2/${apiKey}`)
    expect(mod.getAlchemyWssUrl()).toBe(`wss://eth-mainnet.g.alchemy.com/v2/${apiKey}`)
  })

  it('returns undefined Alchemy URLs when no key/URL is configured', async () => {
    const mod = await loadConfigWithEnv({
      ALCHEMY_API_KEY: '',
      ALCHEMY_RPC_URL: '',
      ALCHEMY_WSS_URL: '',
    })

    expect(mod.getAlchemyHttpUrl()).toBeUndefined()
    expect(mod.getAlchemyWssUrl()).toBeUndefined()
  })

  it('parses optional feature flags as booleans', async () => {
    const mod = await loadConfigWithEnv({
      ENABLE_WHALE_TRACKER: 'true',
      ENABLE_DEPENDENCY_GRAPH: 'false',
    })

    expect(mod.config.enableWhaleTracker).toBe(true)
    expect(mod.config.enableDependencyGraph).toBe(false)
  })
})
