/**
 * Protocol data types — reserve data, asset info, dependency graph.
 */

// ─── Aave V3 Reserve Data ───────────────────────────────────────────

export interface AaveReserveData {
  asset: string
  symbol: string
  configuration: bigint
  liquidityIndex: bigint
  currentLiquidityRate: bigint    // Ray (1e27)
  variableBorrowIndex: bigint
  currentVariableBorrowRate: bigint // Ray (1e27)
  lastUpdateTimestamp: number
  aTokenAddress: string
  variableDebtTokenAddress: string
  // Decoded from configuration bitmap
  ltv: number                     // BPS (10000 = 100%)
  liquidationThreshold: number    // BPS
  liquidationBonus: number        // BPS (10500 = 5% bonus)
  borrowCap: bigint
  supplyCap: bigint
  reserveFactor: number           // BPS
  isFrozen: boolean
  isPaused: boolean
  isBorrowingEnabled: boolean
}

// ─── Compound V3 Asset Info ─────────────────────────────────────────

export interface CompoundAssetInfo {
  cometAddress: string
  asset: string
  symbol: string
  priceFeed: string
  borrowCollateralFactor: bigint
  liquidateCollateralFactor: bigint
  supplyCap: bigint
  scale: bigint
}

// ─── Curve Gauge Data ───────────────────────────────────────────────

export interface CurveGaugeWeight {
  gaugeAddress: string
  relativeWeight: bigint // 1e18 scale
  absoluteWeight: bigint
}

// ─── Cross-Protocol Dependency Graph ────────────────────────────────

export interface DependencyNode {
  id: string                    // e.g. "aave:WETH" or "curve:stETH/ETH"
  protocol: string
  asset: string
  tvl: bigint
  currentParams: Record<string, string | number | boolean>
}

export type EdgeType = 'collateral' | 'liquidity' | 'gauge' | 'oracle' | 'recursive'

export interface DependencyEdge {
  from: string
  to: string
  type: EdgeType
  weight: number                // normalized importance 0-1
  description: string
}

export interface ParamChange {
  param: string
  oldValue: string | number
  newValue: string | number
}

// ─── Liquidation Simulation ─────────────────────────────────────────

export interface LiquidationRisk {
  userAddress: string
  healthFactor: number
  newHealthFactor: number
  totalCollateralUsd: string
  totalDebtUsd: string
  primaryCollateral: string
  atRisk: boolean // newHealthFactor < 1
}

export interface LiquidationSimResult {
  paramChange: ParamChange
  affectedPositions: number
  totalAtRiskUsd: string
  liquidationRisks: LiquidationRisk[]
}

// ─── Pendle Market Data ─────────────────────────────────────────────

export interface PendleMarket {
  address: string
  chainId: number
  name: string
  ptAddress: string
  ytAddress: string
  syAddress: string
  underlyingAsset: string
  expiry: string        // ISO timestamp
  impliedApy: number
  underlyingApy: number
  tvl: number
  ptDiscount: number
}

// ─── dYdX Market Data ───────────────────────────────────────────────

export interface DydxMarket {
  market: string          // e.g. 'AAVE-USD'
  status: string
  oraclePrice: string
  baseAsset: string
  tickSize: string
  stepSize: string
  initialMarginFraction: string
  maintenanceMarginFraction: string
}

export interface DydxPosition {
  market: string
  status: string
  side: string
  size: string
  maxSize: string
  entryPrice: string
  exitPrice?: string
  unrealizedPnl: string
  realizedPnl: string
  netFunding: string
}
