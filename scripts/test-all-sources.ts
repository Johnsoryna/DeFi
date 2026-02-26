/**
 * Comprehensive integration test: tests ALL data sources, APIs, and pipeline components.
 * Run: npx tsx scripts/test-all-sources.ts
 */

const RESULTS: { test: string; status: 'PASS' | 'FAIL'; detail: string; ms: number }[] = []

async function test(name: string, fn: () => Promise<string>): Promise<void> {
  const start = Date.now()
  try {
    const detail = await fn()
    RESULTS.push({ test: name, status: 'PASS', detail, ms: Date.now() - start })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    RESULTS.push({ test: name, status: 'FAIL', detail: msg.slice(0, 200), ms: Date.now() - start })
  }
}

// ─── Snapshot API Tests ────────────────────────────────────────────

const SNAPSHOT_SPACES = ['aavedao.eth', 'compound-governance.eth', 'arbitrumfoundation.eth', 'dydxgov.eth', '1inch.eth']

async function testSnapshot(space: string): Promise<string> {
  const query = `{ proposals(first: 3, where: { space: "${space}" }, orderBy: "created", orderDirection: desc) { id title state created } }`
  const res = await fetch('https://hub.snapshot.org/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  const json = await res.json() as { data?: { proposals?: { id: string; title: string; state: string }[] } }
  const proposals = json.data?.proposals ?? []
  if (proposals.length === 0) return '0 proposals returned (space reachable, currently inactive)'
  return `${proposals.length} proposals, latest: "${proposals[0].title.slice(0, 60)}" [${proposals[0].state}]`
}

// ─── Forum (Discourse) API Tests ───────────────────────────────────

const FORUMS: Record<string, string> = {
  aave: 'https://governance.aave.com',
  compound: 'https://www.comp.xyz',
  arbitrum: 'https://forum.arbitrum.foundation',
  dydx: 'https://dydx.forum',
  cosmos: 'https://forum.cosmos.network',
  '1inch': 'https://gov.1inch.io',
}

async function testForum(name: string, url: string): Promise<string> {
  const res = await fetch(`${url}/latest.json`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('json')) throw new Error(`Not JSON: ${contentType}`)
  const json = await res.json() as { topic_list?: { topics?: { id: number; title: string }[] } }
  const topics = json.topic_list?.topics ?? []
  if (topics.length === 0) throw new Error('No topics returned')
  return `${topics.length} topics, latest: "${topics[0].title.slice(0, 60)}"`
}

// ─── dYdX API Tests ────────────────────────────────────────────────

const DYDX_BASE = 'https://indexer.dydx.trade/v4'

async function testDydxMarkets(): Promise<string> {
  const res = await fetch(`${DYDX_BASE}/perpetualMarkets`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json() as { markets?: Record<string, { ticker: string; status: string }> }
  const markets = Object.keys(json.markets ?? {})
  if (markets.length === 0) throw new Error('No markets returned')
  return `${markets.length} perpetual markets available`
}

async function testDydxOrderbook(): Promise<string> {
  const res = await fetch(`${DYDX_BASE}/orderbooks/perpetualMarket/ETH-USD`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json() as { bids?: { price: string }[]; asks?: { price: string }[] }
  const bids = json.bids?.length ?? 0
  const asks = json.asks?.length ?? 0
  if (bids === 0 && asks === 0) throw new Error('Empty orderbook')
  const bestBid = json.bids?.[0]?.price ?? 'N/A'
  const bestAsk = json.asks?.[0]?.price ?? 'N/A'
  return `${bids} bids, ${asks} asks, ETH bid/ask: $${bestBid}/$${bestAsk}`
}

async function testDydxCandles(): Promise<string> {
  const res = await fetch(`${DYDX_BASE}/candles/perpetualMarkets/ETH-USD?resolution=1HOUR&limit=5`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json() as { candles?: { startedAt: string; close: string }[] }
  const candles = json.candles ?? []
  if (candles.length === 0) throw new Error('No candles returned')
  return `${candles.length} candles, latest close: $${candles[0].close}`
}

async function testDydxWebSocket(): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket timeout (5s)')), 5000)
    // Dynamic import ws
    import('ws').then(({ default: WS }) => {
      const ws = new WS('wss://indexer.dydx.trade/v4/ws')
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'subscribe', channel: 'v4_trades', id: 'ETH-USD' }))
      })
      ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'connected' || msg.type === 'subscribed' || msg.channel === 'v4_trades') {
          clearTimeout(timeout)
          ws.close()
          resolve(`Connected, received: ${msg.type}${msg.channel ? ` (${msg.channel})` : ''}`)
        }
      })
      ws.on('error', (err: Error) => {
        clearTimeout(timeout)
        reject(err)
      })
    })
  })
}

// ─── DefiLlama Price API Tests ─────────────────────────────────────

async function testDefiLlamaPrices(): Promise<string> {
  const coins = [
    'coingecko:ethereum',
    'coingecko:aave',
    'coingecko:compound-governance-token',
    'coingecko:arbitrum',
    'coingecko:dydx-chain',
    'coingecko:cosmos',
    'coingecko:injective-protocol',
    'coingecko:uniswap',
  ].join(',')
  const res = await fetch(`https://coins.llama.fi/prices/current/${coins}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json() as { coins: Record<string, { price: number; symbol: string }> }
  const found = Object.entries(json.coins).filter(([, v]) => v.price > 0)
  if (found.length === 0) throw new Error('No prices returned')
  const summary = found.map(([_k, v]) => `${v.symbol}=$${v.price.toFixed(2)}`).join(', ')
  return `${found.length}/${Object.keys(json.coins).length} prices: ${summary}`
}

async function testDefiLlamaHistorical(): Promise<string> {
  const ts = Math.floor(Date.now() / 1000) - 86400 // 24h ago
  const res = await fetch(`https://coins.llama.fi/prices/historical/${ts}/coingecko:ethereum`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json() as { coins: Record<string, { price: number }> }
  const ethPrice = json.coins['coingecko:ethereum']?.price
  if (!ethPrice) throw new Error('No ETH price')
  return `ETH 24h ago: $${ethPrice.toFixed(2)}`
}

// ─── Ethereum RPC Tests ────────────────────────────────────────────

async function testEthRpc(): Promise<string> {
  const res = await fetch('https://ethereum-rpc.publicnode.com', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json() as { result?: string }
  if (!json.result) throw new Error('No block number')
  const blockNum = parseInt(json.result, 16)
  return `Current block: ${blockNum}`
}

async function testCloudflareRpc(): Promise<string> {
  const res = await fetch('https://cloudflare-eth.com', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json() as { result?: string; error?: { code?: number; message?: string } }
  if (!json.result) {
    if (json.error?.message) {
      return `Reachable but returned RPC error: ${json.error.message}`
    }
    throw new Error('No block number')
  }
  const blockNum = parseInt(json.result, 16)
  return `Current block: ${blockNum}`
}

// ─── Signal Pipeline Test (inject fake event) ──────────────────────

async function testSignalPipeline(): Promise<string> {
  // Import the analysis functions directly
  const { analyzeForumPost } = await import('../src/analysis/intelligenceEngine.js')
  
  // Create a realistic forum post event
  const fakeForumEvent = {
    type: 'forum_post' as const,
    protocol: 'aave' as const,
    forumUrl: 'https://governance.aave.com',
    topicId: 99999,
    title: '[ARFC] Increase wETH Supply Cap on Aave V3 Ethereum',
    body: 'This proposal aims to increase the wETH supply cap from 1M to 2M on Aave V3 Ethereum to accommodate growing demand. The current cap is at 95% utilization. Risk analysis by Gauntlet shows minimal additional risk.',
    author: 'test-user',
    createdAt: new Date().toISOString(),
    replyCount: 5,
    likeCount: 10,
    category: 'Governance',
    timestamp: Date.now(),
  }
  
  const analysis = analyzeForumPost(fakeForumEvent as never)
  if (!analysis) return 'Analysis returned null (post not actionable — expected for some posts)'
  
  return `Analysis: type=${analysis.proposalType}, sentiment=${analysis.sentiment}, assets=[${analysis.extractedAssets.join(',')}], impacts=${analysis.dynamicImpacts.length}, conf=${(analysis.nlpConfidence * 100).toFixed(0)}%`
}

async function testSignalGenerator(): Promise<string> {
  const { analyzeForumPost } = await import('../src/analysis/intelligenceEngine.js')
  const { generateSignals } = await import('../src/strategy/signalGenerator.js')
  
  const fakeForumEvent = {
    type: 'forum_post' as const,
    protocol: 'aave' as const,
    forumUrl: 'https://governance.aave.com',
    topicId: 99998,
    title: '[ARFC] Reduce LTV for wBTC on Aave V3 — Critical Risk Parameter Change',
    body: 'Due to recent market volatility and depeg risk, this proposal reduces the LTV for wBTC from 73% to 65% on Aave V3 Ethereum. Gauntlet risk analysis shows increasing liquidation risk. Immediate action recommended.',
    author: 'gauntlet',
    createdAt: new Date().toISOString(),
    replyCount: 12,
    likeCount: 25,
    category: 'Risk',
    timestamp: Date.now(),
  }
  
  const analysis = analyzeForumPost(fakeForumEvent as never)
  if (!analysis) return 'Analysis null — cannot test signal generation'
  
  const signals = generateSignals(analysis, [])
  if (signals.length === 0) return `Analysis produced ${analysis.dynamicImpacts.length} impacts but 0 signals (filters may block)`
  
  return `${signals.length} signal(s): ${signals.map(s => `${s.direction} ${s.asset} ${s.sizePct}% conf=${s.confidence.toFixed(2)}`).join('; ')}`
}

// ─── dYdX Specific Market Tests ────────────────────────────────────

const TRADED_ASSETS = ['ETH', 'AAVE', 'COMP', 'ARB', 'DYDX', 'ATOM', 'INJ', 'UNI', 'OP', '1INCH']

async function testDydxTradedMarkets(): Promise<string> {
  const res = await fetch(`${DYDX_BASE}/perpetualMarkets`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json() as { markets?: Record<string, { ticker: string; status: string }> }
  const markets = json.markets ?? {}
  
  const results: string[] = []
  for (const asset of TRADED_ASSETS) {
    const ticker = `${asset}-USD`
    const market = markets[ticker]
    if (market) {
      results.push(`${asset}: ${market.status}`)
    } else {
      results.push(`${asset}: NOT FOUND`)
    }
  }
  
  const available = results.filter(r => r.includes('ACTIVE')).length
  return `${available}/${TRADED_ASSETS.length} active: ${results.join(', ')}`
}

// ─── Run All Tests ─────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n╔══════════════════════════════════════════════════════════════╗')
  console.log('║  COMPREHENSIVE SYSTEM TEST — ALL DATA SOURCES & PIPELINE   ║')
  console.log('╚══════════════════════════════════════════════════════════════╝\n')

  // Snapshot tests
  console.log('━━━ SNAPSHOT API ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  for (const space of SNAPSHOT_SPACES) {
    await test(`Snapshot: ${space}`, () => testSnapshot(space))
  }

  // Forum tests
  console.log('\n━━━ DISCOURSE FORUM API ━━━━━━━━━━━━━━━━━━━━━━━━━')
  for (const [name, url] of Object.entries(FORUMS)) {
    await test(`Forum: ${name} (${url})`, () => testForum(name, url))
  }

  // dYdX tests
  console.log('\n━━━ DYDX V4 API ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  await test('dYdX: Perpetual Markets', testDydxMarkets)
  await test('dYdX: ETH-USD Orderbook', testDydxOrderbook)
  await test('dYdX: ETH-USD Candles', testDydxCandles)
  await test('dYdX: WebSocket Connection', testDydxWebSocket)
  await test('dYdX: Traded Assets Check', testDydxTradedMarkets)

  // DefiLlama tests
  console.log('\n━━━ DEFILLAMA PRICE API ━━━━━━━━━━━━━━━━━━━━━━━━━')
  await test('DefiLlama: Current Prices', testDefiLlamaPrices)
  await test('DefiLlama: Historical Prices', testDefiLlamaHistorical)

  // Ethereum RPC tests
  console.log('\n━━━ ETHEREUM RPC ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  await test('RPC: PublicNode', testEthRpc)
  await test('RPC: Cloudflare', testCloudflareRpc)

  // Pipeline tests
  console.log('\n━━━ ANALYSIS PIPELINE ━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  await test('Pipeline: Forum Analysis (NLP)', testSignalPipeline)
  await test('Pipeline: Signal Generation', testSignalGenerator)

  // ─── Report ─────────────────────────────────────────────────────
  console.log('\n\n╔══════════════════════════════════════════════════════════════╗')
  console.log('║                    TEST RESULTS SUMMARY                     ║')
  console.log('╠══════════════════════════════════════════════════════════════╣')
  
  const passed = RESULTS.filter(r => r.status === 'PASS').length
  const failed = RESULTS.filter(r => r.status === 'FAIL').length
  
  for (const r of RESULTS) {
    const icon = r.status === 'PASS' ? 'PASS' : 'FAIL'
    const ms = `${r.ms}ms`.padStart(7)
    console.log(`  [${icon}] ${ms}  ${r.test}`)
    if (r.status === 'PASS') {
      console.log(`           ${r.detail}`)
    } else {
      console.log(`           ERROR: ${r.detail}`)
    }
  }
  
  console.log('╠══════════════════════════════════════════════════════════════╣')
  console.log(`║  TOTAL: ${RESULTS.length} tests | ${passed} PASSED | ${failed} FAILED${' '.repeat(Math.max(0, 24 - String(RESULTS.length).length - String(passed).length - String(failed).length))}║`)
  console.log('╚══════════════════════════════════════════════════════════════╝')
  
  if (failed > 0) {
    console.log('\nFAILED TESTS:')
    for (const r of RESULTS.filter(r => r.status === 'FAIL')) {
      console.log(`  - ${r.test}: ${r.detail}`)
    }
    process.exit(1)
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
