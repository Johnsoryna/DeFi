/**
 * Proposal classifier.
 * Maps decoded proposal actions to impact categories for signal generation.
 */
import { AAVE_V3, COMPOUND_V3 } from '../config/addresses.js'
import { createLogger } from '../lib/logger.js'
import type { DecodedAction, ImpactCategory, ProposalImpact } from '../types/governance.js'

const log = createLogger('classifier')

// ─── Function Name → Impact Category Mapping ────────────────────────

const FUNCTION_IMPACT_MAP: Record<string, ImpactCategory> = {
  // Aave V3 PoolConfigurator
  configureReserveAsCollateral: 'ltv_change',
  setBorrowCap: 'borrow_cap_change',
  setSupplyCap: 'supply_cap_change',
  setReserveFreeze: 'reserve_freeze',
  setDebtCeiling: 'debt_ceiling_change',
  setReserveFactor: 'reserve_factor_change',
  setEModeCategory: 'emode_change',
  setSiloedBorrowing: 'other',
  setReservePause: 'reserve_freeze',
  setReserveInterestRateStrategyAddress: 'interest_rate_change',

  // Compound V3 Configurator
  updateAssetBorrowCollateralFactor: 'ltv_change',
  updateAssetLiquidateCollateralFactor: 'liquidation_threshold_change',
  updateAssetSupplyCap: 'supply_cap_change',
  setSupplyKink: 'interest_rate_change',
  setBorrowKink: 'interest_rate_change',
  setSupplyPerYearInterestRateSlopeLow: 'interest_rate_change',
  setSupplyPerYearInterestRateSlopeHigh: 'interest_rate_change',
  setBorrowPerYearInterestRateSlopeLow: 'interest_rate_change',
  setBorrowPerYearInterestRateSlopeHigh: 'interest_rate_change',
  setBorrowPerYearInterestRateBase: 'interest_rate_change',

  // MakerDAO DssExecLib
  setIlkDebtCeiling: 'debt_ceiling_change',
  setIlkStabilityFee: 'stability_fee_change',
  setIlkLiquidationRatio: 'liquidation_threshold_change',
  setDSR: 'dsr_change',
  setIlkAutoLineParameters: 'debt_ceiling_change',
  setIlkLiquidationPenalty: 'liquidation_threshold_change',
  setIlkMaxLiquidationAmount: 'liquidation_threshold_change',

  // Compound proxy upgrades (typically IR curve changes)
  deployAndUpgradeTo: 'interest_rate_change',

  // Asset listing / delisting patterns
  initReserve: 'asset_listing',
  initReserves: 'asset_listing',
  dropReserve: 'asset_delisting',

  // Oracle changes
  setAssetSources: 'oracle_change',
  setOracle: 'oracle_change',
  updatePriceFeed: 'oracle_change',
}

// ─── Known Target Addresses ─────────────────────────────────────────

const _KNOWN_TARGETS = new Map<string, string>([
  [AAVE_V3.poolConfigurator.toLowerCase(), 'Aave V3 PoolConfigurator'],
  [AAVE_V3.pool.toLowerCase(), 'Aave V3 Pool'],
  [COMPOUND_V3.cUSDCv3.toLowerCase(), 'Compound cUSDCv3'],
  [COMPOUND_V3.cWETHv3.toLowerCase(), 'Compound cWETHv3'],
  [COMPOUND_V3.cUSDTv3.toLowerCase(), 'Compound cUSDTv3'],
])

// Compound Configurator — updateAsset*(comet, asset, newValue) puts the
// comet address in param0 and the ACTUAL asset in param1.
const _COMPOUND_CONFIGURATOR = '0x316f9708bb98af7da9c68c1c3b5e79039cd336e3'

/**
 * Compound Configurator functions where param0=comet, param1=asset.
 * For these we must use param1 (the real asset), not param0 (the comet market).
 */
const COMPOUND_CONFIG_FUNCTIONS = new Set([
  'updateAssetSupplyCap',
  'updateAssetBorrowCollateralFactor',
  'updateAssetLiquidateCollateralFactor',
  'updateAssetLiquidationFactor',
  'updateAssetPriceFeed',
])

// ─── Severity Assessment ────────────────────────────────────────────

function assessSeverity(category: ImpactCategory, _params: Record<string, unknown>): 'low' | 'medium' | 'high' | 'critical' {
  switch (category) {
    case 'reserve_freeze':
    case 'asset_delisting':
      return 'critical'

    case 'ltv_change':
    case 'liquidation_threshold_change':
      return 'high'

    case 'supply_cap_change':
    case 'borrow_cap_change':
    case 'debt_ceiling_change':
      return 'medium'

    case 'interest_rate_change':
    case 'reserve_factor_change':
    case 'stability_fee_change':
    case 'dsr_change':
      return 'medium'

    case 'asset_listing':
    case 'oracle_change':
    case 'emode_change':
      return 'high'

    default:
      return 'low'
  }
}

// ─── Main Classifier ────────────────────────────────────────────────

/**
 * Classify a single decoded action into an impact category.
 */
export function classifyAction(action: DecodedAction): ImpactCategory {
  const funcName = extractFunctionName(action.signature)
  return FUNCTION_IMPACT_MAP[funcName] ?? 'other'
}

/**
 * Classify all actions in a proposal and generate impact assessments.
 * Deduplicates: multiple actions with the same category+asset in one proposal
 * produce only ONE impact (keeps the one with the most detail).
 */
export function classifyProposal(actions: DecodedAction[]): ProposalImpact[] {
  const impacts: ProposalImpact[] = []
  const seen = new Set<string>() // "category:asset" dedup key

  for (const action of actions) {
    const category = classifyAction(action)

    if (category === 'other') {
      log.debug({ signature: action.signature, target: action.target }, 'Unclassified action')
      continue
    }

    const asset = extractAffectedAsset(action)

    // Deduplicate: same category + same asset → skip
    const dedupKey = `${category}:${asset.toLowerCase()}`
    if (seen.has(dedupKey)) {
      log.debug({ category, asset, signature: action.signature }, 'Duplicate impact — skipping')
      continue
    }
    seen.add(dedupKey)

    const severity = assessSeverity(category, action.params)

    const impact: ProposalImpact = {
      category,
      asset,
      severity,
    }

    // Try to extract current/proposed values for delta computation
    const values = extractParameterValues(category, action)
    if (values) {
      impact.currentValue = values.current
      impact.proposedValue = values.proposed
      impact.delta = values.delta
    }

    impacts.push(impact)
    log.info(
      { category, asset, severity, signature: action.signature },
      'Classified proposal action',
    )
  }

  return impacts
}

// ─── Helpers ────────────────────────────────────────────────────────

function extractFunctionName(signature: string): string {
  if (!signature) return ''

  // Handle "DssExecLib.setIlkDebtCeiling(...)" format
  if (signature.startsWith('DssExecLib.')) {
    const after = signature.slice('DssExecLib.'.length)
    return after.split('(')[0]
  }

  // Handle "functionName(type1,type2)" format
  return signature.split('(')[0]
}

function extractAffectedAsset(action: DecodedAction): string {
  const params = action.params
  const funcName = extractFunctionName(action.signature)

  // Compound Configurator: updateAsset*(comet, asset, newValue)
  // param0 = comet market (cUSDCv3/cWETHv3), param1 = actual asset being modified
  if (
    COMPOUND_CONFIG_FUNCTIONS.has(funcName) &&
    params.param1 && typeof params.param1 === 'string' && params.param1.startsWith('0x')
  ) {
    return params.param1
  }

  // Aave PoolConfigurator: configureReserveAsCollateral(asset, ltv, lt, lb)
  // param0 IS the asset for Aave functions
  if (params?.param0 && typeof params.param0 === 'string' && params.param0.startsWith('0x')) {
    return params.param0
  }

  if (params?.asset && typeof params.asset === 'string') {
    return params.asset
  }

  if (params?.ilk && typeof params.ilk === 'string') {
    return params.ilk
  }

  return action.target
}

/**
 * Extract parameter values from decoded action.
 * NOTE: This only extracts 'proposed' values from the calldata.
 * Extracting 'current' values would require on-chain state reads,
 * which is not implemented here for performance reasons.
 */
function extractParameterValues(
  category: ImpactCategory,
  action: DecodedAction,
): { current?: string; proposed?: string; delta?: string } | null {
  const params = action.params

  switch (category) {
    case 'ltv_change': {
      // Compound updateAssetBorrowCollateralFactor(comet, asset, factor):
      //   param0=comet, param1=asset (address), param2=factor (the actual LTV value)
      // Aave configureReserveAsCollateral(asset, ltv, liqThreshold, liqBonus):
      //   param0=asset, param1=ltv (the actual LTV value)
      // Use param2 first (Compound), fall back to param1 (Aave), then named field.
      const proposed = params.param2 ?? params.param1 ?? params.ltv
      if (proposed !== undefined) {
        return { proposed: String(proposed) }
      }
      break
    }

    case 'supply_cap_change':
    case 'borrow_cap_change': {
      // Compound Configurator: param2 = new cap (param0=comet, param1=asset)
      // Aave: param1 = new cap
      const proposed = params.param2 ?? params.param1 ?? params.newBorrowCap ?? params.newSupplyCap
      if (proposed !== undefined) {
        return { proposed: String(proposed) }
      }
      break
    }

    case 'debt_ceiling_change': {
      const proposed = params.param1 ?? params.debtCeiling ?? params.newDebtCeiling
      if (proposed !== undefined) {
        return { proposed: String(proposed) }
      }
      break
    }

    case 'reserve_factor_change': {
      const proposed = params.param1 ?? params.newReserveFactor
      if (proposed !== undefined) {
        return { proposed: String(proposed) }
      }
      break
    }
  }

  return null
}

/**
 * Get all unique impact categories from a proposal's actions.
 */
export function getImpactCategories(actions: DecodedAction[]): ImpactCategory[] {
  const categories = new Set<ImpactCategory>()
  for (const action of actions) {
    const category = classifyAction(action)
    if (category !== 'other') categories.add(category)
  }
  return [...categories]
}
