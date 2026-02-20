/**
 * Snapshot proposal title/body classifier.
 *
 * Aave v3 on-chain governance events don't carry decodable targets/signatures
 * (they use a payload-based system with IPFS hashes). However, every Aave
 * proposal starts as a Snapshot vote with a descriptive title like:
 *   "[ARFC] Prime Instance - wstETH Borrow Rate + rsETH Supply Cap Update"
 *
 * This module extracts ImpactCategory + affected asset from those titles.
 */
import { createLogger } from '../lib/logger.js'
import type { ImpactCategory, ProposalImpact } from '../types/governance.js'

const log = createLogger('snapshot-classifier')

// ─── Title Pattern → Impact Category Mapping ────────────────────────

interface TitlePattern {
  pattern: RegExp
  category: ImpactCategory
  severity: 'low' | 'medium' | 'high' | 'critical'
}

const TITLE_PATTERNS: TitlePattern[] = [
  // LTV / Liquidation Threshold
  { pattern: /\bLTV\b/i, category: 'ltv_change', severity: 'high' },
  { pattern: /\bLT\s*\/?\s*LTV\b/i, category: 'ltv_change', severity: 'high' },
  { pattern: /\bliquidation\s+threshold/i, category: 'liquidation_threshold_change', severity: 'high' },
  { pattern: /\bRestore\s+\w+\s+LTV/i, category: 'ltv_change', severity: 'high' },
  { pattern: /\bLT\s*Adjustment/i, category: 'liquidation_threshold_change', severity: 'high' },

  // Supply / Borrow Caps
  { pattern: /\bSupply\s*Cap/i, category: 'supply_cap_change', severity: 'medium' },
  { pattern: /\bBorrow\s*Cap/i, category: 'borrow_cap_change', severity: 'medium' },
  { pattern: /\bCap\s*(Update|Increase|Decrease|Recommendation)/i, category: 'supply_cap_change', severity: 'medium' },

  // Interest Rates
  { pattern: /\bBorrow\s*Rate/i, category: 'interest_rate_change', severity: 'medium' },
  { pattern: /\bInterest\s*Rate/i, category: 'interest_rate_change', severity: 'medium' },
  { pattern: /\bIR\s*Curve/i, category: 'interest_rate_change', severity: 'medium' },
  { pattern: /\bRate\s*Update/i, category: 'interest_rate_change', severity: 'medium' },
  { pattern: /\bSlope\b.*\bRate/i, category: 'interest_rate_change', severity: 'medium' },

  // Reserve Freeze / Pause
  { pattern: /\bFreeze\b/i, category: 'reserve_freeze', severity: 'critical' },
  { pattern: /\bPause\b/i, category: 'reserve_freeze', severity: 'critical' },
  { pattern: /\bSunset\b/i, category: 'reserve_freeze', severity: 'high' },

  // Asset Listing / Delisting
  { pattern: /\bOnboard\b/i, category: 'asset_listing', severity: 'high' },
  { pattern: /\bAdd\s+\w+\s+to\b/i, category: 'asset_listing', severity: 'high' },
  { pattern: /\bDelist/i, category: 'asset_delisting', severity: 'critical' },
  { pattern: /\bRemove\s+\w+\s+from\b/i, category: 'asset_delisting', severity: 'high' },

  // Deployment / Launch patterns (Aave tends to vote on these)
  { pattern: /\bDeploy\b.*\bv3\b/i, category: 'asset_listing', severity: 'high' },
  { pattern: /\bLaunch\s+GHO\b/i, category: 'asset_listing', severity: 'high' },

  // Risk Parameters (generic)
  { pattern: /\bRisk\s*Parameter/i, category: 'ltv_change', severity: 'high' },
  { pattern: /\bCollateral\s*(Factor|Ratio)/i, category: 'ltv_change', severity: 'high' },

  // Reserve Factor
  { pattern: /\bReserve\s*Factor/i, category: 'reserve_factor_change', severity: 'medium' },

  // E-Mode
  { pattern: /\bE-?Mode/i, category: 'emode_change', severity: 'high' },

  // Oracle
  { pattern: /\bOracle/i, category: 'oracle_change', severity: 'high' },
  { pattern: /\bPrice\s*Feed/i, category: 'oracle_change', severity: 'high' },

  // Debt Ceiling
  { pattern: /\bDebt\s*Ceiling/i, category: 'debt_ceiling_change', severity: 'medium' },
]

// ─── Asset Extraction from Title ────────────────────────────────────

/**
 * Well-known DeFi token symbols that appear in Snapshot titles.
 * Ordered by length descending to match longer tokens first (e.g. "wstETH" before "ETH").
 */
const KNOWN_ASSET_SYMBOLS = [
  'wstETH', 'weETH', 'rsETH', 'cbETH', 'stETH', 'rETH', 'pufETH', 'osETH',
  'WETH', 'WBTC', 'ETH', 'BTC',
  'USDC', 'USDT', 'DAI', 'FRAX', 'LUSD', 'GHO', 'sUSD', 'crvUSD', 'PYUSD',
  'sUSDe', 'USDe', 'lisUSD', 'EURC',
  'LINK', 'AAVE', 'COMP', 'UNI', 'MKR', 'SNX', 'CRV', 'BAL', 'LDO',
  '1INCH', 'RPL', 'ENS', 'FXS', 'KNC', 'SUSHI',
  'stMATIC', 'MATIC', 'MaticX', 'cbBTC',
].sort((a, b) => b.length - a.length) // Match longer first

function extractAssetsFromTitle(title: string): string[] {
  const assets: string[] = []
  const seen = new Set<string>()

  for (const symbol of KNOWN_ASSET_SYMBOLS) {
    // Word-boundary match with case-insensitive flag for better matching
    const regex = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    if (regex.test(title) && !seen.has(symbol.toUpperCase())) {
      seen.add(symbol.toUpperCase())
      assets.push(symbol)
    }
  }

  return assets
}

// ─── Direction Detection ────────────────────────────────────────────

/**
 * Detect whether the title indicates an increase or decrease.
 * Returns +1 for increase, -1 for decrease, 0 for unknown.
 */
function detectDirection(title: string): number {
  const lowerTitle = title.toLowerCase()

  // Increase indicators
  const increasePatterns = [
    /\bincrease\b/,
    /\braise\b/,
    /\badd\b/,
    /\brestore\b/,
    /\bonboard\b/,
    /\bexpand\b/,
    /\bgrow\b/,
    /\bboost\b/,
  ]

  // Decrease indicators (weighted higher for critical actions)
  const decreasePatterns = [
    /\bdecrease\b/,
    /\breduce\b/,
    /\blower\b/,
    /\bremove\b/,
    /\bsunset\b/,
    /\bfreeze\b/,
    /\bpause\b/,
    /\bdelist\b/,
    /\bcut\b/,
  ]

  const hasIncrease = increasePatterns.some((p) => p.test(lowerTitle))
  const hasDecrease = decreasePatterns.some((p) => p.test(lowerTitle))

  if (hasIncrease && !hasDecrease) return 1
  if (hasDecrease && !hasIncrease) return -1
  
  // If both are present, prioritize decrease (more conservative for risk)
  if (hasIncrease && hasDecrease) {
    log.debug({ title }, 'Ambiguous direction (both increase and decrease) — defaulting to decrease')
    return -1
  }
  
  return 0 // Neutral
}

/**
 * Extract numerical values from title (e.g., "90% to 85%" or "from 90% to 85%").
 * Returns { current, proposed } if found.
 * Normalizes percentage values (90% -> 90, 0.90 -> 90).
 */
function extractNumericalValues(title: string): { current?: string; proposed?: string } | null {
  // Pattern: "X% to Y%" or "from X% to Y%" or "X -> Y"
  const patterns = [
    /(\d+(?:\.\d+)?)\s*%?\s*(?:to|->|→)\s*(\d+(?:\.\d+)?)\s*%?/i,
    /from\s+(\d+(?:\.\d+)?)\s*%?\s+to\s+(\d+(?:\.\d+)?)\s*%?/i,
  ]

  for (const pattern of patterns) {
    const match = title.match(pattern)
    if (match) {
      let current = parseFloat(match[1])
      let proposed = parseFloat(match[2])
      
      // Normalize: if values are < 1, assume they're fractions (0.90 -> 90)
      if (current < 1 && current > 0) current *= 100
      if (proposed < 1 && proposed > 0) proposed *= 100
      
      return {
        current: current.toString(),
        proposed: proposed.toString(),
      }
    }
  }

  return null
}

// ─── Main Classifier ────────────────────────────────────────────────

/**
 * Classify a Snapshot proposal by its title (and optionally body).
 * Returns impact categories with affected assets extracted from the text.
 * Now includes direction detection and numerical value extraction.
 */
export function classifySnapshotProposal(
  title: string,
  _body?: string,
): ProposalImpact[] {
  const impacts: ProposalImpact[] = []
  const text = title // We primarily use the title — body is too noisy

  // Find matching impact categories
  const matchedCategories = new Set<ImpactCategory>()
  const categoryDetails: Array<{ category: ImpactCategory; severity: 'low' | 'medium' | 'high' | 'critical' }> = []

  for (const { pattern, category, severity } of TITLE_PATTERNS) {
    if (pattern.test(text) && !matchedCategories.has(category)) {
      matchedCategories.add(category)
      categoryDetails.push({ category, severity })
    }
  }

  if (categoryDetails.length === 0) {
    return impacts
  }

  // Extract affected assets
  const assets = extractAssetsFromTitle(title)

  // If no specific assets found, skip — we can't generate useful signals without an asset
  if (assets.length === 0) {
    log.debug({ title }, 'Snapshot classified but no asset identified')
    return impacts
  }

  // Detect direction (+1 = increase, -1 = decrease, 0 = unknown)
  const direction = detectDirection(title)

  // Try to extract numerical values
  const numericalValues = extractNumericalValues(title)

  // Generate one impact per category × asset combination
  for (const { category, severity } of categoryDetails) {
    for (const asset of assets) {
      const impact: ProposalImpact = {
        category,
        asset,
        severity,
      }

      // Set delta based on direction detection (used by detectDecrease in signalGenerator)
      if (direction !== 0) {
        impact.delta = direction > 0 ? '+1' : '-1'
      }

      // If we found numerical values, add them
      if (numericalValues) {
        impact.currentValue = numericalValues.current
        impact.proposedValue = numericalValues.proposed
        // Calculate delta if both values present
        if (numericalValues.current && numericalValues.proposed) {
          const delta = parseFloat(numericalValues.proposed) - parseFloat(numericalValues.current)
          impact.delta = delta.toString()
        }
      }

      impacts.push(impact)
    }
  }

  log.info(
    {
      title: title.slice(0, 100),
      categories: [...matchedCategories].join(', '),
      assets: assets.join(', '),
      direction: direction > 0 ? 'increase' : direction < 0 ? 'decrease' : 'unknown',
    },
    'Snapshot proposal classified',
  )

  return impacts
}
