/**
 * All verified contract addresses used by the governance alpha bot.
 * Ethereum mainnet unless otherwise noted.
 */

// ─── Governance Contracts ─────────────────────────────────────────────
export const GOVERNANCE = {
  compoundGovernorBravo: '0xc0Da02939E1441F497fd74F78cE7Decb17B66529' as const,
  uniswapGovernorBravo: '0x408ED6354d4973f66138C91495F2f2FCbd8724C3' as const,
  aaveGovernanceCore: '0x9AEE0B04504CeF83A65AC3f0e838D0593BCb2BC7' as const,
  // VotingMachine: original deployment was 0x06a1795a88b82700896583e123F46BE43877bFb6,
  // but Aave proposal #273 deployed new non-upgradeable VotingMachine contracts.
  // The GovernanceV3Ethereum address book now references the address below.
  // Verify on-chain via GovernanceCore.getVotingMachineAddress() before production use.
  aaveVotingMachine: '0x617332a777780F546261247F621051d0b98975Eb' as const,
  aaveVotingMachinePolygon: '0x44c8b753229006A8047A05b90379A7e92185E97C' as const,
  aaveVotingMachineAvalanche: '0x4D1863d22D0ED8579f8999388BCC833CB057C2d6' as const,
  /** Sky Chief V3 — ACTIVE governance contract using SKY tokens */
  makerNewChief: '0x929d9A1435662357F54AdcF64DcEE4d6b867a6f9' as const,
} as const

// ─── Protocol Contracts ───────────────────────────────────────────────
export const AAVE_V3 = {
  pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2' as const,
  poolConfigurator: '0x64b761D848206f447Fe2dd461b0c635Ec39EbB27' as const,
  poolAddressesProvider: '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e' as const,
} as const

export const COMPOUND_V3 = {
  cUSDCv3: '0xc3d688B66703497DAA19211EEdff47f25384cdc3' as const,
  cWETHv3: '0xA17581A9E3356d9A858b789D68B4d866e593aE94' as const,
  cUSDTv3: '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840' as const,
} as const

export const CURVE = {
  gaugeController: '0x2F50D538606Fa9EDD2B11E2446BEb18C9D5846bB' as const,
} as const

export const UNISWAP = {
  universalRouter: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af' as const,
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const,
} as const

// ─── Governance Token Contracts ───────────────────────────────────────
export const TOKENS = {
  COMP: '0xc00e94Cb662C3520282E6f5717214004A7f26888' as const,
  AAVE: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as const,
  UNI: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984' as const,
  MKR: '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2' as const,
  SKY: '0x56072C95FAA701256059aa122697B133aDEd9279' as const,
  // ─── Additional Protocol Governance Tokens ─────────────────────
  LDO: '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32' as const,
  ARB: '0x912CE59144191C1204E64559FE8253a0e49E6548' as const, // Arbitrum One L2
  CRV: '0xD533a949740bb3306d119CC777fa900bA034cd52' as const,
  OP: '0x4200000000000000000000000000000000000042' as const, // Optimism L2
  SNX: '0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F' as const,
  DYDX: '0x92D6C1e31e14520e676a687F0a93788B716BEff5' as const,
  ENA: '0x57e114B691Db790C35207b2e685D4A43181e6061' as const,
  EIGEN: '0xec53bF9167f50cDEB3Ae105f56099aaab9061F83' as const,
  // ─── New Protocol Governance Tokens (Ethereum mainnet) ──────
  POL: '0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6' as const,
  STRK: '0xCa14007Eff0dB1f8135f4C25B34De49AB0d42766' as const,
  MORPHO: '0x9994E35Db50125E0DF82e4c2dde62496CE330999' as const,
  MNT: '0x3c3a81e81dc49A522A592e7622A7E711c06bf354' as const,
  CVX: '0x4e3FBD56Cd56c3e0999aA169D8438eEA3F35ef4d' as const,
  // GMX, JUP, TIA, AVAX, SUI, SEI — no Ethereum mainnet ERC-20 (multi-chain tokens)
} as const

// ─── Binance Futures (USDT-M) Endpoints ──────────────────────────────
// WebSocket base URLs intentionally omit /ws — the client appends
// /ws/<stream> for raw streams or /stream?streams= for combined streams.
export const BINANCE = {
  futuresRest: 'https://fapi.binance.com' as const,
  futuresWs: 'wss://fstream.binance.com' as const,
  /** Demo trading endpoints (Futures Demo API) */
  testnetRest: 'https://demo-fapi.binance.com' as const,
  testnetWs: 'wss://fstream.binancefuture.com' as const,
} as const

// ─── External API Endpoints ──────────────────────────────────────────
export const APIS = {
  snapshotGraphql: 'https://hub.snapshot.org/graphql' as const,
  defiLlamaProtocols: 'https://api.llama.fi/protocols' as const,
  defiLlamaTvl: 'https://api.llama.fi/tvl' as const,
  defiLlamaPrices: 'https://coins.llama.fi/prices/current' as const,
  defiLlamaPricesHistorical: 'https://coins.llama.fi/prices/historical' as const,
  etherscan: 'https://api.etherscan.io/api' as const,
  theGraphGateway: 'https://gateway.thegraph.com/api' as const,
  aaveV3SubgraphId: 'HB1Z2EAw4rtPRYVb2Nz8QGFLHCpym6ByBX6vbCViuE9F' as const,
} as const

// ─── Discourse Forum URLs ────────────────────────────────────────────
// Only profitable protocols (backtested with positive P&L)
export const FORUMS = {
  aave: 'https://governance.aave.com' as const,
  compound: 'https://www.comp.xyz' as const,
  arbitrum: 'https://forum.arbitrum.foundation' as const,
  dydx: 'https://dydx.forum' as const,
  maker: 'https://forum.makerdao.com' as const,
  curve: 'https://gov.curve.fi' as const,
  morpho: 'https://forum.morpho.org' as const,
  lido: 'https://research.lido.fi' as const,
  eigenlayer: 'https://forum.eigenlayer.xyz' as const,
  uniswap: 'https://gov.uniswap.org' as const,
  // ─── Removed (0 trades, no risk-parameter alpha) ─────────────────────────
  // cosmos/1inch/ens/near/synthetix/optimism/sui/celestia/avalanche/ethena: no alpha
  // zksync/starknet/jupiter/pyth/stacks/jito/balancer/euler/etherfi/wormhole: 0 trades
  // frax: 0 trades in backtest
} as const

// ─── Snapshot Spaces ─────────────────────────────────────────────────
// NOTE: Aave DAO migrated from 'aave.eth' to 'aavedao.eth' in January 2026.
// See: https://snapshot.org/#/s:aavedao.eth
export const SNAPSHOT_SPACES = [
  'aavedao.eth',
  'compound-governance.eth',
  'arbitrumfoundation.eth',
  'dydxgov.eth',
  'lido-snapshot.eth',
  'morpho.eth',
  'veyfi.eth',
  'gmx.eth',
  'snxgov.eth',
  // ─── Removed (0 trades, no risk-parameter alpha) ─────────────────────────
  // '1inch.eth': fusion protocol operational governance
  // 'cvx.eth': 563 gauge-weight votes, NLP correctly rejects all
  // 'starknet.eth': L2 operational governance
  // 'ens.eth': treasury/delegate compensation governance
  // 'ethenagovernance.eth': ENA cascade via COLLATERAL_ISSUER_TOKEN, no protocol monitor needed
  // 'etherfi-dao.eth': treasury/buyback/seasonal rewards (Mar 2026)
  // 'frax.eth': 0 trades in backtest
  // 'balancer.eth': no BALUSDT Binance perp (delisted)
  // 'pendle-politics.eth': 0 proposals in DB
  // 'eulerdao.eth': routine Gauntlet param updates, neutral NLP, 0 trades
] as const

// ─── All Governance Token Addresses (for delegation tracking) ────────
export const DELEGATION_TOKEN_ADDRESSES = [
  TOKENS.COMP,
  TOKENS.AAVE,
  TOKENS.LDO,
  TOKENS.ARB,
  TOKENS.DYDX,
] as const

// ─── Canonical Stablecoin Set ────────────────────────────────────────
// SINGLE source of truth — imported by all modules that need stablecoin filtering.
// These assets are pegged and don't have enough volatility for directional trading.
export const STABLECOINS = new Set([
  'USDT', 'USDC', 'DAI', 'FRAX', 'LUSD', 'USDE', 'PYUSD', 'TUSD',
  'GUSD', 'BUSD', 'SUSD', 'CUSD', 'GHO', 'USDS', 'USDG', 'MUSD',
  'FRXUSD', 'CRVUSD', 'USDAI',
])

// USDT address (reference — collateral on Binance Futures is USDT)
export const USDT_ADDRESS = '0xdAC17F958D2ee523a2206206994597C13D831ec7' as const
