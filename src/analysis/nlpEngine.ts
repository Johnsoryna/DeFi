/**
 * NLP Engine for governance proposal analysis.
 *
 * Pure TypeScript implementation — no external APIs or ML models required.
 * Uses weighted keyword scoring for proposal type classification,
 * multi-pass token extraction, and sentiment analysis.
 *
 * Replaces the old pattern-matching classifier (snapshotClassifier.ts) with
 * a flexible system that can classify ALL proposal types, not just technical ones.
 */
import { createLogger } from '../lib/logger.js'
import type { ProposalType, PriceImpactExpectation } from '../types/governance.js'

const log = createLogger('nlp-engine')

// ─── Types ───────────────────────────────────────────────────────────

export interface NLPResult {
  proposalType: ProposalType
  typeConfidence: number
  extractedAssets: string[]
  sentiment: 'bullish' | 'bearish' | 'neutral'
  sentimentScore: number // -1 to 1
  expectedPriceImpact: PriceImpactExpectation
  keywords: string[]
  isActionable: boolean
  direction: number // +1 increase, -1 decrease, 0 unknown
  numericalValues: { current?: string; proposed?: string } | null
}

// ─── Keyword Clusters for Type Classification ────────────────────────

interface KeywordCluster {
  type: ProposalType
  keywords: Array<{ pattern: RegExp; weight: number }>
  minScore: number // minimum total score to be selected
}

const KEYWORD_CLUSTERS: KeywordCluster[] = [
  {
    type: 'technical_parameter',
    minScore: 2.0,
    keywords: [
      { pattern: /\bLTV\b/i, weight: 3.0 },
      { pattern: /\bLT\s*\/?\s*LTV\b/i, weight: 3.0 },
      { pattern: /\bliquidation\s+threshold/i, weight: 3.0 },
      { pattern: /\bsupply\s*cap/i, weight: 3.0 },
      { pattern: /\bborrow\s*cap/i, weight: 3.0 },
      { pattern: /\binterest\s*rate/i, weight: 3.0 },
      { pattern: /\bborrow\s*rate/i, weight: 3.0 },
      { pattern: /\bdebt\s*ceiling/i, weight: 2.5 },
      { pattern: /\bslope\b/i, weight: 2.0 },
      { pattern: /\bkink\b/i, weight: 2.0 },
      { pattern: /\be-?mode/i, weight: 2.5 },
      { pattern: /\brisk\s*parameter/i, weight: 2.5 },
      { pattern: /\bcollateral\s*(factor|ratio)/i, weight: 2.5 },
      { pattern: /\breserve\s*factor/i, weight: 2.0 },
      { pattern: /\brate\s*update/i, weight: 2.0 },
      { pattern: /\bIR\s*curve/i, weight: 2.5 },
      { pattern: /\bLT\s*(adjust|change|update)/i, weight: 2.5 },
      { pattern: /\bcap\s*(update|increase|decrease|recommendation)/i, weight: 2.0 },
      { pattern: /\bstability\s*fee/i, weight: 2.5 },
      { pattern: /\bDSR\b/i, weight: 2.5 },
      // Additional patterns for proposals misclassified as governance_process
      { pattern: /\bAPY\s*(adjust|update|change|modify)/i, weight: 2.0 },
      { pattern: /\byield\s*(adjust|update|modify|change)/i, weight: 2.0 },
      { pattern: /\bmultiplier\b/i, weight: 1.5 },
      { pattern: /\bparameter\s*(tuning|optimization|adjust)/i, weight: 1.5 },
      { pattern: /\bweight\s*(adjust|update|change)/i, weight: 1.5 },
    ],
  },
  {
    type: 'asset_onboarding',
    minScore: 2.0,
    keywords: [
      { pattern: /\bonboard\b/i, weight: 3.0 },
      { pattern: /\badd\s+\w+\s+to\b/i, weight: 2.5 },
      { pattern: /\bnew\s+(asset|market|collateral|reserve)\b/i, weight: 2.0 },
      { pattern: /\benable\s+\w+\s+(as|for)\b/i, weight: 2.0 },
      { pattern: /\blisting\b/i, weight: 2.0 },
      { pattern: /\bactivate\b/i, weight: 1.5 },
      { pattern: /\bcore\s+instance\b/i, weight: 1.0 },
      { pattern: /\binitReserve/i, weight: 3.0 },
    ],
  },
  {
    type: 'protocol_deployment',
    minScore: 2.0,
    keywords: [
      { pattern: /\bdeploy\b/i, weight: 3.0 },
      { pattern: /\blaunch\b/i, weight: 2.5 },
      { pattern: /\bexpansion\b/i, weight: 2.0 },
      { pattern: /\bnew\s+chain\b/i, weight: 2.5 },
      { pattern: /\bnew\s+instance\b/i, weight: 2.0 },
      { pattern: /\bintegration\b/i, weight: 1.5 },
      { pattern: /\bon\s+(Base|Arbitrum|Optimism|Polygon|Avalanche|BSC|Linea|Scroll|zkSync|Plasma|Ink|X\s*Layer)\b/i, weight: 2.0 },
      { pattern: /\bv3\s+on\b/i, weight: 2.0 },
      { pattern: /\bmultichain\b/i, weight: 2.0 },
      { pattern: /\bcross-?chain\b/i, weight: 1.5 },
    ],
  },
  {
    type: 'treasury_funding',
    minScore: 1.5,
    keywords: [
      { pattern: /\bfunding\b/i, weight: 3.0 },
      { pattern: /\bfund\b/i, weight: 1.5 },
      { pattern: /\bbudget\b/i, weight: 2.5 },
      { pattern: /\btreasury\b/i, weight: 2.5 },
      { pattern: /\bgrant\b/i, weight: 2.0 },
      { pattern: /\bcommittee\b/i, weight: 1.5 },
      { pattern: /\bprogram\b/i, weight: 1.5 },
      { pattern: /\brenewal\b/i, weight: 1.5 },
      { pattern: /\bcompensation\b/i, weight: 2.0 },
      { pattern: /\bmerit\b/i, weight: 2.0 },
      { pattern: /\bpayment\b/i, weight: 2.0 },
      { pattern: /\bphase\s+(I{1,3}V?|V?I{0,3}|\d+)\b/i, weight: 1.5 },
      { pattern: /\borbit\b/i, weight: 1.5 },
      { pattern: /\bservice\s*provider/i, weight: 2.0 },
      { pattern: /\bstream\b/i, weight: 1.0 },
    ],
  },
  {
    type: 'governance_process',
    minScore: 1.0,
    keywords: [
      { pattern: /\bframework\b/i, weight: 2.5 },
      { pattern: /\bagreement\b/i, weight: 2.0 },
      { pattern: /\bendorse\b/i, weight: 2.0 },
      { pattern: /\badopt\b/i, weight: 2.0 },
      { pattern: /\bconstitution\b/i, weight: 2.5 },
      { pattern: /\bcharter\b/i, weight: 2.5 },
      { pattern: /\bstandard\b/i, weight: 1.5 },
      { pattern: /\bclassification\b/i, weight: 1.5 },
      { pattern: /\bvoting\b/i, weight: 1.0 },
      { pattern: /\bquorum\b/i, weight: 1.5 },
      { pattern: /\bforum\b/i, weight: 1.0 },
      { pattern: /\ballowlist\b/i, weight: 1.5 },
      { pattern: /\bsafe\s*harbor/i, weight: 2.0 },
      { pattern: /\bcandidate\b/i, weight: 1.0 },
      { pattern: /\btransparency\b/i, weight: 1.5 },
      { pattern: /\breport\b/i, weight: 1.0 },
    ],
  },
  {
    type: 'risk_mitigation',
    minScore: 2.0,
    keywords: [
      { pattern: /\bdeprecation\b/i, weight: 3.0 },
      { pattern: /\bdeprecate\b/i, weight: 3.0 },
      { pattern: /\bfreeze\b/i, weight: 3.0 },
      { pattern: /\bpause\b/i, weight: 2.5 },
      { pattern: /\bsunset\b/i, weight: 3.0 },
      { pattern: /\bwind(?:ing)?\s*down/i, weight: 3.0 },   // "wind down" AND "winding down"
      { pattern: /\bshut\s*down\b/i, weight: 3.0 },          // "shutdown" and "shut down"
      { pattern: /\bcease\b/i, weight: 2.5 },                 // "cease support"
      { pattern: /\brecall\b/i, weight: 2.0 },                // "recall staking program"
      { pattern: /\bemergency\b/i, weight: 3.0 },
      { pattern: /\bdisable\b/i, weight: 2.0 },
      { pattern: /\boffboard\b/i, weight: 2.5 },
      { pattern: /\bdelist\b/i, weight: 3.0 },
      { pattern: /\bremove\b/i, weight: 2.0 },
      { pattern: /\breduce\b/i, weight: 1.5 },
      // dYdX market-level bearish: explicit market/perpetual removal (C4b)
      { pattern: /\bremove\b.{0,20}\b(?:market|trading\s*pair|perpetual)\b/i, weight: 3.0 },
      { pattern: /\bdelist\b.{0,20}\b(?:market|perpetual)\b/i, weight: 3.0 },
      // MakerDAO DSR decrease → bearish for SKY (C5a routed to risk_mitigation for actual signal)
      { pattern: /\bDSR\b.{0,20}(?:reduc|decreas|cut|lower)/i, weight: 2.5 },
      { pattern: /(?:reduc|decreas|cut|lower).{0,20}\bDSR\b/i, weight: 2.5 },
      // SparkFi (MakerDAO subdao) risk events → co-occurrence guard: needs ≥0.5 from another pattern (C5b)
      { pattern: /\bSpark\s*(?:Fi|Lend|Protocol|DAO)\b/i, weight: 1.5 },
    ],
  },
  {
    type: 'infrastructure',
    minScore: 1.5,
    keywords: [
      { pattern: /\bsteward\b/i, weight: 2.5 },
      { pattern: /\boracle\b/i, weight: 2.0 },
      { pattern: /\bautomation\b/i, weight: 2.0 },
      { pattern: /\bupgrade\b/i, weight: 2.0 },
      { pattern: /\bmigration\b/i, weight: 2.0 },
      { pattern: /\bflash\s*borrower/i, weight: 1.5 },
      { pattern: /\bprice\s*feed/i, weight: 2.0 },
      { pattern: /\bguardian\b/i, weight: 1.5 },
      { pattern: /\bkeeper\b/i, weight: 1.5 },
      { pattern: /\bv\d+\.\d+\b/, weight: 1.5 }, // Version numbers like v3.6
      // Additional patterns for upgrade/migration proposals
      { pattern: /\bupgrade\s+(to|v\d+|version)/i, weight: 2.5 },
      { pattern: /\bmigration\s+(to|from|path)/i, weight: 2.0 },
      { pattern: /\bcontract\s*(upgrade|deployment|migration)/i, weight: 2.0 },
      { pattern: /\bprotocol\s*(upgrade|migration|version)/i, weight: 2.0 },
    ],
  },
  {
    type: 'economic_policy',
    minScore: 1.5,
    keywords: [
      { pattern: /\bemission/i, weight: 3.0 },
      { pattern: /\bincentive/i, weight: 2.5 },
      { pattern: /\breward/i, weight: 2.0 },
      { pattern: /\bstaking\b/i, weight: 2.0 },
      { pattern: /\bbuyback\b/i, weight: 2.5 },   // Treasury buyback programs are economic policy, bullish for gov token
      { pattern: /\bbuy\s*back\b/i, weight: 2.5 },
      { pattern: /\bliquidity\s*(mining|incentive|program)/i, weight: 2.5 },
      { pattern: /\bsafety\s*module/i, weight: 2.5 },
      { pattern: /\bumbrella\b/i, weight: 1.5 },
      { pattern: /\bslashing\b/i, weight: 2.0 },
      { pattern: /\bdistribution\b/i, weight: 1.5 },
      { pattern: /\bfee\s*(redesign|redistribution|share|revenue)/i, weight: 1.5 },
      // Additional patterns for proposals misclassified as governance_process
      { pattern: /\bgauge\s*(add|remove|weight|allocation|vote)/i, weight: 2.5 },
      { pattern: /\brewards?\s*(program|schedule|distribution|pool|rate)/i, weight: 2.0 },
      { pattern: /\bemission\s*(schedule|rate|curve|reduction)/i, weight: 2.5 },
      { pattern: /\bstaking\s*(reward|rate|apy|incentive)/i, weight: 2.0 },
      { pattern: /\bliquidity\s*(farming|reward)/i, weight: 2.0 },
      { pattern: /\btoken\s*(utility|migration|swap|conversion)/i, weight: 2.0 },
    ],
  },
]

// ─── Token Extraction ────────────────────────────────────────────────

/**
 * Extended list of known DeFi token symbols.
 * Superset of the old snapshotClassifier list + new tokens from Snapshot titles.
 */
const KNOWN_TOKENS = new Set([
  // ETH & BTC variants
  'WSTETH', 'WEETH', 'RSETH', 'CBETH', 'STETH', 'RETH', 'PUFETH', 'OSETH',
  'WETH', 'WBTC', 'ETH', 'BTC', 'CBBTC', 'TBTC',
  // Stablecoins
  'USDC', 'USDT', 'DAI', 'FRAX', 'LUSD', 'GHO', 'SUSD', 'CRVUSD', 'PYUSD',
  'SUSDE', 'USDE', 'LISUSD', 'EURC', 'MUSD', 'USDG', 'USDAI', 'SUSDAI',
  'FRXUSD', 'TUSD', 'TUSDE', 'BUSD', 'USDS', 'SUSDS', 'TUSDE',
  // Governance tokens (core DeFi)
  'LINK', 'AAVE', 'COMP', 'UNI', 'MKR', 'SNX', 'CRV', 'BAL', 'LDO',
  '1INCH', 'RPL', 'ENS', 'FXS', 'KNC', 'SUSHI', 'SKY', 'GNO',
  'DYDX', 'ENA', 'EIGEN',
  'ARB', 'OP',
  // Tier A governance tokens (dYdX vol >$5K/day)
  'GMX', 'JUP', 'TIA', 'AVAX', 'POL', 'STRK', 'MORPHO', 'SUI', 'MNT', 'SEI',
  'ATOM', 'APT', 'AXL', 'NEAR', 'INJ', 'BLUR', 'JTO', 'ZK', 'DRIFT', 'PYTH', 'STX',
  // Other
  'STMATIC', 'MATIC', 'MATICX', 'XAUT', 'LSETH', 'FRXETH',
])

/**
 * Terms that look like token symbols but are NOT tokens.
 * These get excluded from generic pattern extraction.
 */
const TOKEN_EXCLUSIONS = new Set([
  'ARFC', 'TEMP', 'CHECK', 'ACI', 'TVL', 'APY', 'APR', 'USD', 'EUR',
  'BPS', 'PER', 'FOR', 'THE', 'AND', 'ALL', 'SET', 'NEW', 'ADD', 'HAS',
  'NOT', 'CAN', 'WAS', 'ARE', 'BUT', 'HIS', 'HER', 'ITS', 'OUR', 'WHO',
  'SAFE', 'SEAL', 'WAD', 'RAY', 'RAD', 'MAX', 'MIN', 'FEE', 'GAS',
  'CEO', 'CTO', 'COO', 'CFO', 'DAO', 'DEX', 'CEX', 'TGE', 'IDO',
  'RPC', 'API', 'ABI', 'EVM', 'EOA', 'KYC', 'AML', 'SEC', 'MEV',
  'THIS', 'THAT', 'WILL', 'WITH', 'FROM', 'HAVE', 'BEEN', 'SOME',
  'NEXT', 'CORE', 'MAIN', 'BASE', 'RISK', 'RATE', 'VOTE', 'FUND',
  'POOL', 'SWAP', 'LOAN', 'DEBT', 'TERM', 'PLAN', 'PHASE', 'ROUND',
  // Protocol names — AAVE removed: it IS the governance token we trade
])

/**
 * Context patterns that strongly suggest the next word is a token symbol.
 */
const CONTEXT_EXTRACTION_PATTERNS: RegExp[] = [
  /\bonboard\s+([A-Za-z][A-Za-z0-9]{1,10})\b/i,
  /\badd\s+([A-Za-z][A-Za-z0-9]{1,10})\s+to\b/i,
  /\blist(?:ing)?\s+([A-Za-z][A-Za-z0-9]{1,10})\b/i,
  /\benable\s+([A-Za-z][A-Za-z0-9]{1,10})\b/i,
  /\blaunch\s+([A-Za-z][A-Za-z0-9]{1,10})\b/i,
  /\bfreeze\s+([A-Za-z][A-Za-z0-9]{1,10})\b/i,
  /\bpause\s+([A-Za-z][A-Za-z0-9]{1,10})\b/i,
  /\bdelist\s+([A-Za-z][A-Za-z0-9]{1,10})\b/i,
  /\bremove\s+([A-Za-z][A-Za-z0-9]{1,10})\s+from\b/i,
  /\boffboard\s+([A-Za-z][A-Za-z0-9]{1,10})\b/i,
  /\bdeprecate\s+([A-Za-z][A-Za-z0-9]{1,10})\b/i,
  // "X Borrow Rate", "X Supply Cap", "X LTV"
  /\b([A-Za-z][A-Za-z0-9]{1,10})\s+(?:Borrow|Supply|Interest)\s*(?:Rate|Cap)/i,
  /\b([A-Za-z][A-Za-z0-9]{1,10})\s+LTV\b/i,
]

// ─── Sentiment Analysis ──────────────────────────────────────────────

const BULLISH_PATTERNS: Array<{ pattern: RegExp; weight: number }> = [
  { pattern: /\bincrease\b/i, weight: 1.0 },
  { pattern: /\braise\b/i, weight: 1.0 },
  { pattern: /\bgrowth\b/i, weight: 0.8 },
  { pattern: /\bexpand\b/i, weight: 0.8 },
  { pattern: /\bboost\b/i, weight: 1.0 },
  { pattern: /\bbuyback\b/i, weight: 1.0 },
  { pattern: /\bbuy\s*back\b/i, weight: 1.0 },
  { pattern: /\bonboard\b/i, weight: 0.7 },
  { pattern: /\blaunch\b/i, weight: 0.8 },
  { pattern: /\bdeploy\b/i, weight: 0.6 },
  { pattern: /\benable\b/i, weight: 0.5 },
  { pattern: /\bactivate\b/i, weight: 0.5 },
  { pattern: /\brestore\b/i, weight: 0.3 },
  { pattern: /\bnew\s+(?:market|instance|chain)/i, weight: 0.8 },
  { pattern: /\bupgrade\b/i, weight: 0.3 },
  { pattern: /\bintegration\b/i, weight: 0.5 },
  // Protocol-growth signals — governance bullish
  { pattern: /\bsupply\s*cap\s*(?:increase|raise|update)/i, weight: 0.8 },
  { pattern: /\bborrow\s*cap\s*(?:increase|raise)/i, weight: 0.6 },
  { pattern: /\btotal\s*(?:value|supply|TVL)\s*(?:increase|growth|expand)/i, weight: 0.8 },
  { pattern: /\badopt\b/i, weight: 0.4 },
  { pattern: /\brenew(?:al)?\b/i, weight: 0.4 },
  { pattern: /\bpartnership\b/i, weight: 0.6 },
  { pattern: /\bstaking\b/i, weight: 0.4 },
  { pattern: /\bsafety\s*module/i, weight: 0.5 },
]

const BEARISH_PATTERNS: Array<{ pattern: RegExp; weight: number }> = [
  { pattern: /\bdecrease\b/i, weight: -1.0 },
  { pattern: /\breduce\b/i, weight: -0.8 },
  { pattern: /\blower\b/i, weight: -0.8 },
  { pattern: /\bremove\b/i, weight: -0.8 },
  { pattern: /\bsunset\b/i, weight: -1.2 },
  { pattern: /\bfreeze\b/i, weight: -1.5 },
  { pattern: /\bpause\b/i, weight: -1.2 },
  { pattern: /\bdelist\b/i, weight: -1.5 },
  { pattern: /\bdeprecation\b/i, weight: -1.0 },
  { pattern: /\bdeprecate\b/i, weight: -1.0 },
  { pattern: /\bcut\b/i, weight: -0.8 },
  { pattern: /\bwind(?:ing)?\s*down/i, weight: -1.5 },
  { pattern: /\bemergency\b/i, weight: -1.5 },
  { pattern: /\boffboard\b/i, weight: -1.2 },
  { pattern: /\bdisable\b/i, weight: -1.0 },
  { pattern: /\bshut\s*down\b/i, weight: -1.5 },
  { pattern: /\bphaseout\b/i, weight: -1.0 },
  { pattern: /\bcease\b/i, weight: -1.0 },
  { pattern: /\brecall\b/i, weight: -0.8 },
  // Protocol-risk signals — governance bearish
  { pattern: /\bvulnerability\b/i, weight: -1.2 },
  { pattern: /\bexploit\b/i, weight: -1.5 },
  { pattern: /\bhack\b/i, weight: -1.5 },
  { pattern: /\bbreach\b/i, weight: -1.2 },
  { pattern: /\binsolvency\b/i, weight: -1.5 },
  { pattern: /\bbad\s*debt\b/i, weight: -1.2 },
  { pattern: /\bslash(?:ing)?\b/i, weight: -0.8 },
  { pattern: /\bdowngrade\b/i, weight: -1.0 },
  { pattern: /\bsupply\s*cap\s*(?:decrease|reduce|lower)/i, weight: -0.8 },
]

// ─── Numerical Value Extraction ──────────────────────────────────────

function extractNumericalValues(text: string): { current?: string; proposed?: string } | null {
  const patterns = [
    /(\d+(?:\.\d+)?)\s*%?\s*(?:to|->|→)\s*(\d+(?:\.\d+)?)\s*%?/i,
    /from\s+(\d+(?:\.\d+)?)\s*%?\s+to\s+(\d+(?:\.\d+)?)\s*%?/i,
  ]

  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) {
      let current = parseFloat(match[1])
      let proposed = parseFloat(match[2])
      if (current < 1 && current > 0) current *= 100
      if (proposed < 1 && proposed > 0) proposed *= 100
      return { current: current.toString(), proposed: proposed.toString() }
    }
  }

  return null
}

// ─── Protocol → Governance Token Mapping ─────────────────────────────

const PROTOCOL_GOVERNANCE_TOKENS: Record<string, string> = {
  aave: 'AAVE',
  compound: 'COMP',
  uniswap: 'UNI',
  maker: 'SKY',        // MKR migrated to SKY; MKR-USD delisted on dYdX
  lido: 'LDO',
  arbitrum: 'ARB',
  curve: 'CRV',
  synthetix: 'SNX',
  dydx: 'DYDX',
  eigenlayer: 'EIGEN',
  morpho: 'MORPHO',
  yearn: 'YFI',
  gmx: 'GMX',
  // ─── Removed (0 trades, no risk-parameter alpha) ─────────────────────────
  // optimism, ethena, ens: purged in v36
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Analyze a proposal's text content using NLP techniques.
 * Extracts: proposal type, affected assets, sentiment, and trading signals.
 */
export function analyzeText(
  title: string,
  body?: string,
  protocol?: string,
): NLPResult {
  const text = title // Title is the primary source for type classification
  // Use title + first 500 chars of body for sentiment analysis.
  // Body text provides richer directional context than title alone.
  // "Increase supply cap from 200M to 400M" in body → clear bullish direction.
  const sentimentText = body ? `${title} ${body.slice(0, 500)}` : title

  // 1. Classify proposal type
  const { type, confidence: typeConfidence, keywords } = classifyProposalType(text)

  // 2. Extract assets (multi-pass)
  let extractedAssets = extractTokens(text)

  // If title yielded nothing, try first ~200 chars of body
  if (extractedAssets.length === 0 && body) {
    extractedAssets = extractTokens(body.slice(0, 200))
  }

  // Fallback: protocol governance token
  if (extractedAssets.length === 0 && protocol) {
    const govToken = PROTOCOL_GOVERNANCE_TOKENS[protocol]
    if (govToken) {
      extractedAssets = [govToken]
    }
  }

  // 3. Sentiment analysis (uses body text for richer context)
  const { sentiment, score: sentimentScore } = analyzeSentiment(sentimentText)

  // 4. Direction detection (uses body text for richer context)
  const direction = detectDirection(sentimentText)

  // 5. Numerical values — search title AND body for "from X to Y" patterns
  let numericalValues = extractNumericalValues(text)
  if (!numericalValues && body) {
    numericalValues = extractNumericalValues(body.slice(0, 500))
  }

  // 5b. Infer direction from numerical values when keyword detection is inconclusive.
  // "from 100M to 200M" → increase (direction=1), "from 5% to 3%" → decrease (direction=-1)
  // This fills a gap where proposal text says "update X to Y" without explicit increase/decrease keywords.
  let effectiveDirection = direction
  if (effectiveDirection === 0 && numericalValues?.current && numericalValues?.proposed) {
    const current = parseFloat(numericalValues.current)
    const proposed = parseFloat(numericalValues.proposed)
    if (proposed > current) effectiveDirection = 1
    else if (proposed < current) effectiveDirection = -1
  }

  // 6. Determine price impact expectation
  const expectedPriceImpact = determinePriceImpact(type, sentiment, effectiveDirection)

  // 7. Determine if actionable (has both type classification AND at least one asset)
  // Lower threshold (0.15) to capture more early-alpha governance signals
  const isActionable = typeConfidence >= 0.15 && extractedAssets.length > 0

  log.debug(
    {
      title: title.slice(0, 80),
      type,
      typeConfidence: typeConfidence.toFixed(2),
      assets: extractedAssets.join(', '),
      sentiment,
      isActionable,
    },
    'NLP analysis complete',
  )

  return {
    proposalType: type,
    typeConfidence,
    extractedAssets,
    sentiment,
    sentimentScore,
    expectedPriceImpact,
    keywords,
    isActionable,
    direction: effectiveDirection,
    numericalValues,
  }
}

// ─── Internal: Type Classification ───────────────────────────────────

function classifyProposalType(text: string): {
  type: ProposalType
  confidence: number
  keywords: string[]
} {
  const scores: Array<{ type: ProposalType; score: number; keywords: string[] }> = []

  for (const cluster of KEYWORD_CLUSTERS) {
    let score = 0
    const matchedKeywords: string[] = []

    for (const { pattern, weight } of cluster.keywords) {
      if (pattern.test(text)) {
        score += weight
        // Extract the matched keyword for debugging
        const match = text.match(pattern)
        if (match) matchedKeywords.push(match[0])
      }
    }

    if (score >= cluster.minScore) {
      scores.push({ type: cluster.type, score, keywords: matchedKeywords })
    }
  }

  // Sort by score descending
  scores.sort((a, b) => b.score - a.score)

  if (scores.length === 0) {
    // Default: governance_process (catch-all for unclassifiable proposals)
    return { type: 'governance_process', confidence: 0.2, keywords: [] }
  }

  const best = scores[0]
  // Normalize confidence: score relative to the theoretical max (~10)
  const confidence = Math.min(best.score / 6, 1.0)

  return {
    type: best.type,
    confidence,
    keywords: best.keywords,
  }
}

// ─── Internal: Token Extraction (multi-pass) ─────────────────────────

function extractTokens(text: string): string[] {
  const tokens = new Set<string>()

  // Pass 1: Known tokens (exact match, case-insensitive)
  // Sort by length descending to match longer tokens first (wstETH before ETH)
  const sortedKnown = [...KNOWN_TOKENS].sort((a, b) => b.length - a.length)
  for (const symbol of sortedKnown) {
    const regex = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    if (regex.test(text)) {
      tokens.add(symbol)
    }
  }

  // Pass 2: Context-based extraction
  for (const pattern of CONTEXT_EXTRACTION_PATTERNS) {
    const match = text.match(pattern)
    if (match && match[1]) {
      const candidate = match[1].toUpperCase()
      if (!TOKEN_EXCLUSIONS.has(candidate) && candidate.length >= 2 && candidate.length <= 10) {
        tokens.add(candidate)
      }
    }
  }

  // Pass 3: CamelCase token patterns (wstETH, rsETH, cbBTC, etc.)
  const camelPattern = /\b([a-z]{1,4}[A-Z][a-zA-Z0-9]{1,7})\b/g
  let camelMatch
  while ((camelMatch = camelPattern.exec(text)) !== null) {
    const candidate = camelMatch[1].toUpperCase()
    if (!TOKEN_EXCLUSIONS.has(candidate) && candidate.length >= 3) {
      tokens.add(candidate)
    }
  }

  // Pass 4: Uppercase sequences that look like token symbols (3-10 chars)
  // Only if we found fewer than 2 tokens so far
  if (tokens.size < 2) {
    const upperPattern = /\b([A-Z][A-Z0-9]{1,9})\b/g
    let upperMatch
    while ((upperMatch = upperPattern.exec(text)) !== null) {
      const candidate = upperMatch[1]
      if (
        !TOKEN_EXCLUSIONS.has(candidate) &&
        candidate.length >= 3 &&
        candidate.length <= 8 &&
        // Must contain at least one letter after the first
        /[A-Z]/.test(candidate.slice(1)) &&
        // Known token? Higher confidence
        KNOWN_TOKENS.has(candidate)
      ) {
        tokens.add(candidate)
      }
    }
  }

  // Remove generic AAVE if it's about the protocol, not the token
  // (Keep it only if the proposal is specifically about the AAVE token)
  // We'll handle this in the Intelligence Engine instead

  return [...tokens]
}

// ─── Internal: Sentiment Analysis ────────────────────────────────────

function analyzeSentiment(text: string): { sentiment: 'bullish' | 'bearish' | 'neutral'; score: number } {
  let score = 0

  for (const { pattern, weight } of BULLISH_PATTERNS) {
    if (pattern.test(text)) score += weight
  }

  for (const { pattern, weight } of BEARISH_PATTERNS) {
    if (pattern.test(text)) score += weight // weight is already negative
  }

  // Normalize to -1 to 1
  const normalizedScore = Math.max(-1, Math.min(1, score / 3))

  // Sentiment threshold: 0.08 → narrower neutral zone → more directional signals.
  // Reduced from 0.10: many governance proposals with clear actions ("increase supply cap")
  // score 0.08-0.10 and were being classified as neutral. With PF 3.24 and 85% WR on shorts,
  // capturing more directional signals is justified.
  if (normalizedScore > 0.08) return { sentiment: 'bullish', score: normalizedScore }
  if (normalizedScore < -0.08) return { sentiment: 'bearish', score: normalizedScore }
  return { sentiment: 'neutral', score: normalizedScore }
}

// ─── Internal: Direction Detection ───────────────────────────────────

function detectDirection(text: string): number {
  const lower = text.toLowerCase()

  const increasePatterns = [
    /\bincrease\b/, /\braise\b/, /\badd\b/, /\brestore\b/,
    /\bonboard\b/, /\bexpand\b/, /\bgrow\b/, /\bboost\b/,
    /\benable\b/, /\bactivate\b/, /\blaunch\b/, /\bdeploy\b/,
  ]

  const decreasePatterns = [
    /\bdecrease\b/, /\breduce\b/, /\blower\b/, /\bremove\b/,
    /\bsunset\b/, /\bfreeze\b/, /\bpause\b/, /\bdelist\b/,
    /\bcut\b/, /\bdisable\b/, /\boffboard\b/, /\bdeprecate\b/,
    /\bshut\s*down\b/, /\bcease\b/, /\brecall\b/, /\bwind(?:ing)?\s*down/,
  ]

  const hasIncrease = increasePatterns.some((p) => p.test(lower))
  const hasDecrease = decreasePatterns.some((p) => p.test(lower))

  if (hasIncrease && !hasDecrease) return 1
  if (hasDecrease && !hasIncrease) return -1
  if (hasIncrease && hasDecrease) return -1 // Conservative
  return 0
}

// ─── Internal: Price Impact Determination ────────────────────────────

function determinePriceImpact(
  type: ProposalType,
  sentiment: 'bullish' | 'bearish' | 'neutral',
  direction: number,
): PriceImpactExpectation {
  // Type-based impact expectations.
  // CRITICAL: For types with numeric direction (increase/decrease), use the
  // NLP direction field FIRST. "Increase Supply Cap" has direction=+1 from
  // keyword detection — this is MORE reliable than sentiment for parameter changes.
  // Previously, direction was only used for risk_mitigation, causing many
  // technical_parameter signals to fall through as 'neutral' and be skipped.
  switch (type) {
    case 'asset_onboarding':
      return 'positive' // New listings are generally bullish
    case 'protocol_deployment':
      return 'positive' // Expansion is bullish for protocol token
    case 'risk_mitigation':
      if (direction < 0) return 'negative'
      if (direction > 0) return 'neutral' // Risk mitigation + increase direction = unclear
      return sentiment === 'bearish' ? 'negative' : 'neutral'
    case 'technical_parameter':
      // Direction has priority: "increase" → positive, "decrease/reduce" → negative
      if (direction > 0) return 'positive'
      if (direction < 0) return 'negative'
      // Fallback to sentiment
      if (sentiment === 'bearish') return 'negative'
      if (sentiment === 'bullish') return 'positive'
      return 'neutral'
    case 'economic_policy':
      // Economic policy: sentiment-driven (buybacks, staking, emissions)
      if (sentiment === 'bullish') return 'positive'
      if (sentiment === 'bearish') return 'negative'
      return 'neutral'
    case 'treasury_funding':
      return 'neutral' // Funding doesn't directly impact prices
    case 'governance_process':
      return 'neutral'
    case 'infrastructure':
      return 'neutral'
    default:
      return 'neutral'
  }
}
