/**
 * Asset resolver — maps contract addresses to price symbols and vice versa.
 *
 * The proposal classifier returns contract addresses as asset identifiers
 * (e.g. "0xA175..."), but historical prices are stored by symbol (e.g. "WETH").
 * This module bridges the gap so the MockPriceMonitor can find prices.
 *
 * Also handles well-known DeFi assets that appear as proposal targets
 * (e.g. Compound cWETHv3 → WETH, Aave pool assets → underlying token symbol).
 */
import { TOKENS, COMPOUND_V3, AAVE_V3 } from '../config/addresses.js'

// ─── Address → Symbol Mapping ───────────────────────────────────────

const ADDRESS_TO_SYMBOL: Record<string, string> = {}

// Governance tokens (from TOKENS constant)
for (const [symbol, address] of Object.entries(TOKENS)) {
  ADDRESS_TO_SYMBOL[address.toLowerCase()] = symbol.toUpperCase()
}

// Compound V3 market addresses → underlying asset
ADDRESS_TO_SYMBOL[COMPOUND_V3.cUSDCv3.toLowerCase()] = 'USDC'
ADDRESS_TO_SYMBOL[COMPOUND_V3.cWETHv3.toLowerCase()] = 'WETH'
ADDRESS_TO_SYMBOL[COMPOUND_V3.cUSDTv3.toLowerCase()] = 'USDT'

// Aave V3 contract addresses
ADDRESS_TO_SYMBOL[AAVE_V3.pool.toLowerCase()] = 'AAVE'
ADDRESS_TO_SYMBOL[AAVE_V3.poolConfigurator.toLowerCase()] = 'AAVE'

// Well-known ERC20 tokens commonly seen in governance proposals
const WELL_KNOWN_TOKENS: Record<string, string> = {
  // Stablecoins
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
  '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI',
  '0x4fabb145d64652a948d72533023f6e7a623c7c53': 'BUSD',
  '0x853d955acef822db058eb8505911ed77f175b99e': 'FRAX',
  '0x5f98805a4e8be255a32880fdec7f6728c6568ba0': 'LUSD',
  // NOTE: 0x57e114b691db790c35207b2e685d4a43181e6061 is ENA (Ethena), already mapped via TOKENS
  '0x1abaea1f7c830bd89acc67ec4af516284b1bc33c': 'EURC',    // Circle EURC
  '0x57ab1ec28d129707052df4df418d58a2d46d5f51': 'SUSD',    // Synthetix sUSD
  '0x9d39a5de30e57443bff2a8307a4256c8797a3497': 'SUSDE',   // Ethena sUSDe
  '0x4c9edd5852cd905f086c759e8383e09bff1e68b3': 'USDE',    // Ethena USDe
  '0x0022228a2cc5e7ef0274a7baa600d44da5ab5776': 'LISUSD',  // lisUSD
  '0x6c3ea9036406852006290770bedfcaba0e23a0e8': 'PYUSD',   // PayPal PYUSD
  '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f': 'GHO',     // Aave GHO stablecoin
  // Major ETH & BTC
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH',
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 'WBTC',
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': 'CBBTC',   // Coinbase cbBTC
  '0x18084fba666a33d37592fa2633fd49a74dd93a88': 'TBTC',    // Threshold tBTC
  // Liquid Staking Derivatives (LSDs)
  '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0': 'WSTETH',
  '0xae78736cd615f374d3085123a210448e74fc6393': 'RETH',
  '0xbe9895146f7af43049ca1c1ae358b0541ea49704': 'CBETH',
  '0xae7ab96520de3a18e5e111b5eaab095312d7fe84': 'STETH',
  '0xa1290d69c65a6fe4df752f95823fae25cb99e5a7': 'RSETH',   // KelpDAO rsETH
  '0xd5f7838f5c461feff7fe49ea5ebaf7728bb0adfa': 'WEETH',   // ether.fi weETH
  '0xd9a442856c234a39a81a089c06451ebaa4306a72': 'PUFETH',  // Puffer pufETH
  '0xf1c9acdc66974dfb6decb12aa385b9cd01190e38': 'OSETH',   // StakeWise osETH
  '0x9ee91f9f426fa633d227f7a9b000e28b9dfd8599': 'STMATIC', // Lido stMATIC (Ethereum bridged)
  '0x8c1bed5b9a0928467c9b1341da1d7bd5e10b6549': 'LSETH',   // Liquid Staked ETH
  '0xac3e018457b222d93114458476f3e3416abbe38f': 'FRXETH',  // Frax ETH
  // DeFi Governance Tokens
  '0x514910771af9ca656af840dff83e8264ecf986ca': 'LINK',
  '0xd533a949740bb3306d119cc777fa900ba034cd52': 'CRV',
  '0xba100000625a3754423978a60c9317c58a424e3d': 'BAL',
  '0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f': 'SNX',
  '0x5a98fcbea516cf06857215779fd812ca3bef1b32': 'LDO',
  '0x111111111117dc0aa78b770fa6a738034120c302': '1INCH',
  '0xd33526068d116ce69f19a9ee46f0bd304f21a51f': 'RPL',
  '0xc18360217d8f7ab5e7c516566761ea12ce7f9d72': 'ENS',
  '0x3432b6a60d23ca0dfca7761b7ab56459d9c964d0': 'FXS',
  '0x6810e776880c02933d47db1b9fc05908e5386b96': 'GNO',
  // Other DeFi tokens (not actively traded but needed for address resolution)
  '0x6b3595068778dd592e39a122f4f5a5cf09c90fe2': 'SUSHI',
  '0x0bc529c00c6401aef6d220be8c6ea1667f6ad93e': 'YFI',
  '0x808507121b80c02388fad14726482e061b8da827': 'PENDLE',
  // Compound Configurator (maps to protocol, not price — but needed for address resolution)
  '0x316f9708bb98af7da9c68c1c3b5e79039cd336e3': 'COMP_CONFIGURATOR',
  // ─── New Protocol Governance Tokens (Ethereum mainnet) ──────
  '0x4e3fbd56cd56c3e0999aa169d8438eea3f35ef4d': 'CVX',      // Convex Finance
  '0x455e53cbb86018ac2b8092fdcd39d8444affc3f6': 'POL',      // Polygon POL
  '0xca14007eff0db1f8135f4c25b34de49ab0d42766': 'STRK',     // Starknet STRK
  '0x9994e35db50125e0df82e4c2dde62496ce330999': 'MORPHO',   // Morpho
  '0x3c3a81e81dc49a522a592e7622a7e711c06bf354': 'MNT',      // Mantle MNT
  '0xec53bf9167f50cdeb3ae105f56099aaab9061f83': 'EIGEN',    // EigenLayer
}

for (const [addr, symbol] of Object.entries(WELL_KNOWN_TOKENS)) {
  ADDRESS_TO_SYMBOL[addr.toLowerCase()] = symbol
}

// ─── Symbol → Address (reverse lookup) ──────────────────────────────

const SYMBOL_TO_ADDRESS: Record<string, string> = {}
for (const [addr, sym] of Object.entries(ADDRESS_TO_SYMBOL)) {
  if (!SYMBOL_TO_ADDRESS[sym]) {
    SYMBOL_TO_ADDRESS[sym] = addr
  }
}

// ─── Maker Ilk Name → Asset Symbol ─────────────────────────────────

const ILK_TO_SYMBOL: Record<string, string> = {
  'ETH-A': 'WETH',
  'ETH-B': 'WETH',
  'ETH-C': 'WETH',
  'WBTC-A': 'WBTC',
  'WBTC-B': 'WBTC',
  'WBTC-C': 'WBTC',
  'WSTETH-A': 'WSTETH',
  'WSTETH-B': 'WSTETH',
  'RETH-A': 'RETH',
  'LINK-A': 'LINK',
  'COMP-A': 'COMP',
  'UNI-A': 'UNI',
  'AAVE-A': 'AAVE',
  'USDC-A': 'USDC',
  'USDT-A': 'USDT',
}

// ─── Symbol Aliases ─────────────────────────────────────────────────
// Maps common variations to the canonical symbol used in price DB.

const SYMBOL_ALIASES: Record<string, string> = {
  // ETH always maps to WETH (we track wrapped ETH prices)
  'ETH': 'WETH',
  'BTC': 'WBTC',
  // Snapshot titles use mixed case
  'WSTETH': 'WSTETH',
  'WEETH': 'WEETH',
  'RSETH': 'RSETH',
  'PUFETH': 'PUFETH',
  'CBETH': 'CBETH',
  'CBBTC': 'CBBTC',
  'STETH': 'STETH',
  'OSETH': 'OSETH',
  'STMATIC': 'STMATIC',
  'SUSD': 'SUSD',
  'SUSDE': 'SUSDE',
  'USDE': 'USDE',
  'LISUSD': 'LISUSD',
  // MKR migrated to SKY — MKR-USD delisted on dYdX, trade SKY instead
  'MKR': 'SKY',
  // NLP-extracted tokens → nearest priceable symbol
  'TBTC': 'WBTC',       // threshold BTC → track via WBTC
  'LSETH': 'WSTETH',    // Liquid Staked ETH → track via wstETH
  'FRXETH': 'WETH',     // Frax ETH → track via WETH
  'XAUT': 'WETH',       // Tether Gold — no direct price, fallback
  'MUSD': 'USDC',       // MetaMask USD → track via USDC
  'USDG': 'USDC',       // USDG → track via USDC
  'USDAI': 'DAI',       // USDai → track via DAI
  'SUSDAI': 'DAI',      // sUSDai → track via DAI
  'FRXUSD': 'FRAX',     // frxUSD → track via FRAX
  'TUSDE': 'USDE',      // tUSDe → track via USDe
  'TUSD': 'USDC',       // TUSD → track via USDC
  'CRVUSD': 'USDC',      // crvUSD is a stablecoin — track via USDC (not CRV)
  'MATICX': 'STMATIC',  // MaticX → track via stMATIC
  'MATIC': 'STMATIC',   // MATIC → track via stMATIC
  // Protocol internal (not priceable)
  'COMP_CONFIGURATOR': 'COMP',
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Resolve an asset identifier (contract address, ilk name, or symbol) to a
 * price-lookup symbol. Returns the input uppercased if no mapping is found.
 */
export function resolveAssetSymbol(assetId: string): string {
  if (!assetId) return 'UNKNOWN'

  const upper = assetId.toUpperCase()

  // Check alias first (ETH → WETH, etc.)
  if (SYMBOL_ALIASES[upper]) return SYMBOL_ALIASES[upper]

  // Already a known symbol?
  if (SYMBOL_TO_ADDRESS[upper]) return upper

  // Maker ilk name?
  if (ILK_TO_SYMBOL[upper]) return ILK_TO_SYMBOL[upper]
  // Ilk names can have quotes: "ETH-A" → ETH-A
  const cleaned = assetId.replace(/['"]/g, '').toUpperCase()
  if (ILK_TO_SYMBOL[cleaned]) return ILK_TO_SYMBOL[cleaned]

  // Contract address?
  if (assetId.startsWith('0x')) {
    const symbol = ADDRESS_TO_SYMBOL[assetId.toLowerCase()]
    if (symbol) {
      // Apply alias if the resolved symbol itself is an alias (e.g. COMP_CONFIGURATOR → COMP)
      const aliased = SYMBOL_ALIASES[symbol.toUpperCase()]
      if (aliased) return aliased
      return symbol
    }
  }

  // Return the raw value uppercased as a last resort
  return upper
}

/**
 * Get the price-lookup symbol for a token address.
 * Returns null if the address is unknown.
 */
export function addressToSymbol(address: string): string | null {
  return ADDRESS_TO_SYMBOL[address.toLowerCase()] ?? null
}

/**
 * Get all known symbols that have address mappings.
 */
export function getAllKnownSymbols(): string[] {
  return [...new Set(Object.values(ADDRESS_TO_SYMBOL))]
}

/**
 * Get all well-known token addresses (for price collection).
 */
// Symbols that should NOT be treated as priceable tokens
const NON_PRICEABLE_SYMBOLS = new Set(['COMP_CONFIGURATOR'])

// L2 tokens that need non-Ethereum chain for DeFi Llama price lookups
const MULTI_CHAIN_TOKENS: Array<{ symbol: string; address: string; chain: string }> = [
  { symbol: 'ARB', address: '0x912CE59144191C1204E64559FE8253a0e49E6548', chain: 'arbitrum' },
  { symbol: 'OP', address: '0x4200000000000000000000000000000000000042', chain: 'optimism' },
  // ─── New Multi-Chain Governance Tokens ──────────────────────
  { symbol: 'GMX', address: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a', chain: 'arbitrum' },
  { symbol: 'AVAX', address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', chain: 'avax' },   // WAVAX
  // Non-EVM tokens: use coingecko IDs (DeFi Llama format: coingecko:{id})
  { symbol: 'JUP', address: 'jupiter-exchange-solana', chain: 'coingecko' },
  { symbol: 'TIA', address: 'celestia', chain: 'coingecko' },
  { symbol: 'SUI', address: 'sui', chain: 'coingecko' },
  { symbol: 'SEI', address: 'sei-network', chain: 'coingecko' },
  { symbol: 'MORPHO', address: 'morpho', chain: 'coingecko' }, // Ethereum address returns no data; coingecko works
]

export function getAllPriceableAddresses(): Array<{ symbol: string; address: string; chain: string }> {
  const seen = new Set<string>()
  const result: Array<{ symbol: string; address: string; chain: string }> = []

  for (const [addr, symbol] of Object.entries(ADDRESS_TO_SYMBOL)) {
    if (
      !seen.has(symbol) &&
      !NON_PRICEABLE_SYMBOLS.has(symbol) &&
      addr.startsWith('0x') &&
      addr.length === 42
    ) {
      seen.add(symbol)
      result.push({ symbol, address: addr, chain: 'ethereum' })
    }
  }

  // Add multi-chain tokens (L2 governance tokens)
  for (const token of MULTI_CHAIN_TOKENS) {
    if (!seen.has(token.symbol)) {
      seen.add(token.symbol)
      result.push(token)
    }
  }

  return result
}
