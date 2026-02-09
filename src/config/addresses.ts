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
  /** @deprecated Original VotingMachine — superseded by proposal #273 deployment */
  aaveVotingMachineLegacy: '0x06a1795a88b82700896583e123F46BE43877bFb6' as const,
  aaveVotingMachinePolygon: '0x44c8b753229006A8047A05b90379A7e92185E97C' as const,
  aaveVotingMachineAvalanche: '0x4D1863d22D0ED8579f8999388BCC833CB057C2d6' as const,
  /** @deprecated DSChief v1.2 — phased out since May 2025 MKR→SKY migration */
  makerDSChiefV12: '0x0a3f6849f78076aefaDf113F5BED87720274dDC0' as const,
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

export const BALANCER = {
  v2Vault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8' as const,
} as const

export const UNISWAP = {
  // New Universal Router supporting V2, V3, and V4 pools (deployed with V4 launch)
  universalRouter: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af' as const,
  /** @deprecated Legacy Universal Router — V2/V3 only, lacks V4 pool support */
  universalRouterLegacy: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD' as const,
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const,
} as const

export const PENDLE = {
  routerV4: '0x888888888889758F76e7103c6CbF23ABbF58F946' as const,
} as const

// ─── Governance Token Contracts ───────────────────────────────────────
export const TOKENS = {
  COMP: '0xc00e94Cb662C3520282E6f5717214004A7f26888' as const,
  AAVE: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' as const,
  UNI: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984' as const,
  MKR: '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2' as const,
  SKY: '0x56072C95FAA701256059aa122697B133aDEd9279' as const,
} as const

// ─── dYdX v4 Endpoints ───────────────────────────────────────────────
export const DYDX = {
  indexerRest: 'https://indexer.dydx.trade/v4' as const,
  indexerWs: 'wss://indexer.dydx.trade' as const,
  chainRpc: 'https://dydx-ops-rpc.kingnodes.com' as const,
  chainId: 'dydx-mainnet-1' as const,
} as const

// ─── External API Endpoints ──────────────────────────────────────────
export const APIS = {
  snapshotGraphql: 'https://hub.snapshot.org/graphql' as const,
  tallyGraphql: 'https://api.tally.xyz/query' as const,
  cowswap: 'https://api.cow.fi' as const,
  pendleApi: 'https://api-v2.pendle.finance/core' as const,
  defiLlamaProtocols: 'https://api.llama.fi/protocols' as const,
  defiLlamaTvl: 'https://api.llama.fi/tvl' as const,
  defiLlamaPrices: 'https://coins.llama.fi/prices/current' as const,
  defiLlamaPricesHistorical: 'https://coins.llama.fi/prices/historical' as const,
  etherscan: 'https://api.etherscan.io/api' as const,
  theGraphGateway: 'https://gateway.thegraph.com/api' as const,
  aaveV3SubgraphId: 'HB1Z2EAw4rtPRYVb2Nz8QGFLHCpym6ByBX6vbCViuE9F' as const,
} as const

// ─── Discourse Forum URLs ────────────────────────────────────────────
export const FORUMS = {
  aave: 'https://governance.aave.com' as const,
  compound: 'https://www.comp.xyz' as const,
  maker: 'https://forum.makerdao.com' as const,
} as const

// ─── Snapshot Spaces ─────────────────────────────────────────────────
// NOTE: Aave DAO migrated from 'aave.eth' to 'aavedao.eth' in January 2026.
// See: https://snapshot.org/#/s:aavedao.eth
export const SNAPSHOT_SPACES = [
  'aavedao.eth',
  'uniswap',
  'compound-governance.eth',
] as const

// ─── All Governor Bravo Addresses (shared ABI) ──────────────────────
export const GOVERNOR_BRAVO_ADDRESSES = [
  GOVERNANCE.compoundGovernorBravo,
  GOVERNANCE.uniswapGovernorBravo,
] as const

// ─── All Governance Token Addresses (for delegation tracking) ────────
export const DELEGATION_TOKEN_ADDRESSES = [
  TOKENS.COMP,
  TOKENS.AAVE,
  TOKENS.UNI,
  TOKENS.MKR,
  TOKENS.SKY,
] as const
