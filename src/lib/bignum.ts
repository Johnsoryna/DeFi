/**
 * BigInt / BigNumber helpers for DeFi math.
 * Aave uses Ray (1e27) and WAD (1e18) precision.
 * BPS = basis points (10000 = 100%).
 */

// ─── Constants ──────────────────────────────────────────────────────

export const RAY = 10n ** 27n   // Aave ray precision
export const WAD = 10n ** 18n   // Standard ERC20 / WAD precision
export const BPS = 10000n       // Basis points denominator
export const USD_DECIMALS = 10n ** 8n // Aave USD base (8 decimals)

// ─── Conversion Helpers ─────────────────────────────────────────────

/** Convert ray (1e27) to a human-readable decimal string */
export function rayToDecimal(ray: bigint, precision = 6): string {
  const whole = ray / RAY
  const fractional = ray % RAY
  const fracStr = fractional.toString().padStart(27, '0').slice(0, precision)
  return `${whole}.${fracStr}`
}

/** Convert WAD (1e18) to a human-readable decimal string */
export function wadToDecimal(wad: bigint, precision = 6): string {
  const whole = wad / WAD
  const fractional = wad % WAD
  const fracStr = fractional.toString().padStart(18, '0').slice(0, precision)
  return `${whole}.${fracStr}`
}

/** Convert BPS to percentage (e.g., 8250 -> 82.5) */
export function bpsToPercent(bps: number | bigint): number {
  return Number(bps) / 100
}

/** Convert percentage to BPS (e.g., 82.5 -> 8250) */
export function percentToBps(pct: number): bigint {
  return BigInt(Math.round(pct * 100))
}

/** Convert ray rate to APY percentage */
export function rayRateToApy(rayRate: bigint): number {
  // APY = (1 + rate/SECONDS_PER_YEAR)^SECONDS_PER_YEAR - 1
  // Simplified: rate * SECONDS_PER_YEAR / RAY * 100
  const SECONDS_PER_YEAR = 31536000n
  return Number((rayRate * SECONDS_PER_YEAR * 100n) / RAY) / 100
}

// ─── Aave Health Factor ─────────────────────────────────────────────

/**
 * Compute Aave V3 health factor.
 * HF = (totalCollateralBase * liquidationThreshold / 10000) / totalDebtBase
 * All base values in USD with 8 decimals.
 */
export function computeHealthFactor(
  totalCollateralBase: bigint,
  totalDebtBase: bigint,
  liquidationThreshold: bigint, // in BPS (10000 = 100%)
): number {
  if (totalDebtBase === 0n) return Infinity

  // HF = collateral * LT / 10000 / debt
  // Scale up for precision, then divide
  const numerator = totalCollateralBase * liquidationThreshold
  const denominator = totalDebtBase * BPS

  // Convert to float with sufficient precision
  return Number(numerator * 10000n / denominator) / 10000
}

/**
 * Simulate new health factor after a liquidation threshold change.
 * For single-collateral: new_HF = old_HF * (new_LT / old_LT)
 */
export function simulateHfAfterLtChange(
  currentHf: number,
  oldLtBps: number,
  newLtBps: number,
): number {
  return currentHf * (newLtBps / oldLtBps)
}

/**
 * Find the minimum current HF that would become liquidatable
 * after an LT change from oldLt to newLt.
 * Positions with HF < this threshold become at risk.
 */
export function hfLiquidationThreshold(oldLtBps: number, newLtBps: number): number {
  return oldLtBps / newLtBps
}

// ─── Formatting ─────────────────────────────────────────────────────

/** Format a bigint token amount with given decimals to human-readable string */
export function formatTokenAmount(amount: bigint, decimals: number, precision = 4): string {
  const divisor = 10n ** BigInt(decimals)
  const whole = amount / divisor
  const fractional = amount % divisor
  const fracStr = fractional.toString().padStart(decimals, '0').slice(0, precision)
  return `${whole}.${fracStr}`
}

/** Parse a decimal string to bigint with given decimals */
export function parseTokenAmount(amountStr: string, decimals: number): bigint {
  const [whole, frac = ''] = amountStr.split('.')
  const paddedFrac = frac.padEnd(decimals, '0').slice(0, decimals)
  return BigInt(whole + paddedFrac)
}

// ─── Aave Configuration Bitmap Decoder ──────────────────────────────

/**
 * Decode Aave V3 reserve configuration bitmap.
 * Layout (from LSB):
 *   0-15: LTV, 16-31: Liq threshold, 32-47: Liq bonus,
 *   48-55: Decimals, 56: Active, 57: Frozen, 58: Borrowing,
 *   59: Stable borrowing, 60: Paused,
 *   64-79: Reserve factor, 80-115: Borrow cap, 116-151: Supply cap,
 *   ...
 */
export function decodeAaveReserveConfig(config: bigint) {
  const ltv = Number(config & 0xFFFFn)
  const liquidationThreshold = Number((config >> 16n) & 0xFFFFn)
  const liquidationBonus = Number((config >> 32n) & 0xFFFFn)
  const decimals = Number((config >> 48n) & 0xFFn)
  const isActive = Boolean((config >> 56n) & 1n)
  const isFrozen = Boolean((config >> 57n) & 1n)
  const isBorrowingEnabled = Boolean((config >> 58n) & 1n)
  const isPaused = Boolean((config >> 60n) & 1n)
  const reserveFactor = Number((config >> 64n) & 0xFFFFn)
  const borrowCap = (config >> 80n) & 0xFFFFFFFFFn    // 36 bits
  const supplyCap = (config >> 116n) & 0xFFFFFFFFFn   // 36 bits

  return {
    ltv,
    liquidationThreshold,
    liquidationBonus,
    decimals,
    isActive,
    isFrozen,
    isBorrowingEnabled,
    isPaused,
    reserveFactor,
    borrowCap,
    supplyCap,
  }
}
