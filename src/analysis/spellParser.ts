/**
 * MakerDAO executive spell parser.
 * Parses verified spell source code to extract DssExecLib calls.
 */
import { createLogger } from '../lib/logger.js'
import { withRetry } from '../lib/retry.js'
import { config } from '../config/index.js'
import type { DecodedAction, ImpactCategory } from '../types/governance.js'

const log = createLogger('spell-parser')

// ─── DssExecLib Function Categories ─────────────────────────────────

const DSSEXECLIB_CATEGORIES: Record<string, ImpactCategory> = {
  setIlkDebtCeiling: 'debt_ceiling_change',
  setIlkAutoLineParameters: 'debt_ceiling_change',
  setIlkAutoLineDebtCeiling: 'debt_ceiling_change',
  increaseIlkDebtCeiling: 'debt_ceiling_change',
  decreaseIlkDebtCeiling: 'debt_ceiling_change',
  removeIlkFromAutoLine: 'debt_ceiling_change',
  setIlkStabilityFee: 'stability_fee_change',
  setDSR: 'dsr_change',
  setIlkLiquidationRatio: 'liquidation_threshold_change',
  setIlkLiquidationPenalty: 'liquidation_threshold_change',
  setIlkMaxLiquidationAmount: 'liquidation_threshold_change',
  setIlkMinVaultAmount: 'debt_ceiling_change',
  setStartingPriceMultiplicativeFactor: 'oracle_change',
  setAuctionTimeBeforeReset: 'other',
  setChangelogAddress: 'other',
  authorize: 'other',
  deauthorize: 'other',
}

// ─── Source Fetching ────────────────────────────────────────────────

/**
 * Fetch verified contract source from Etherscan.
 */
async function fetchEtherscanSource(address: string): Promise<string | null> {
  if (!config.etherscanApiKey) {
    log.warn('Etherscan API key not configured')
    return null
  }

  return withRetry(
    async () => {
      const url =
        `https://api.etherscan.io/api?module=contract&action=getsourcecode` +
        `&address=${address}&apikey=${config.etherscanApiKey}`

      const res = await fetch(url)
      if (!res.ok) throw new Error(`Etherscan ${res.status}`)

      const data = (await res.json()) as {
        status: string
        result: Array<{ SourceCode: string; ContractName: string }>
      }

      if (data.status !== '1' || !data.result?.[0]?.SourceCode) {
        return null
      }

      return data.result[0].SourceCode
    },
    `etherscan-source-${address}`,
    { maxRetries: 2, baseDelayMs: 1200 },
  )
}

// ─── Spell Source Parsing ───────────────────────────────────────────

/**
 * Parse a MakerDAO executive spell source code.
 * Extracts DssExecLib function calls from the actions() function body.
 */
export function parseSpellSource(source: string, spellAddress: string): DecodedAction[] {
  const actions: DecodedAction[] = []

  // Find the actions() function body
  const actionsBody = extractActionsBody(source)
  if (!actionsBody) {
    log.debug('Could not find actions() function body')
    // Fall back to scanning the entire source
    return scanForDssExecLibCalls(source, spellAddress)
  }

  return scanForDssExecLibCalls(actionsBody, spellAddress)
}

/**
 * Extract the body of the actions() function from spell source.
 */
function extractActionsBody(source: string): string | null {
  // Match: function actions() internal override { ... }
  // or: function actions() public override { ... }
  const patterns = [
    /function\s+actions\s*\(\s*\)\s*(?:internal|public|external)\s*(?:override)?\s*\{/,
    /function\s+officeHours\s*\(\s*\)/,
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(source)
    if (!match) continue

    const startIdx = match.index + match[0].length
    let depth = 1
    let idx = startIdx

    while (idx < source.length && depth > 0) {
      if (source[idx] === '{') depth++
      if (source[idx] === '}') depth--
      idx++
    }

    if (depth === 0) {
      return source.slice(startIdx, idx - 1)
    }
  }

  return null
}

/**
 * Scan source text for DssExecLib.* calls and extract structured actions.
 */
function scanForDssExecLibCalls(source: string, spellAddress: string): DecodedAction[] {
  const actions: DecodedAction[] = []

  // Pattern: DssExecLib.functionName(arg1, arg2, ...)
  const pattern = /DssExecLib\.(\w+)\s*\(([^;]*?)\)/gs
  let match

  while ((match = pattern.exec(source)) !== null) {
    const funcName = match[1]
    const argsRaw = match[2].trim()

    // Parse arguments, handling nested expressions
    const args = parseArgs(argsRaw)

    const params: Record<string, unknown> = {
      functionName: funcName,
      rawArgs: args,
    }

    // Assign named parameters based on function
    assignNamedParams(funcName, args, params)

    actions.push({
      target: spellAddress,
      signature: `DssExecLib.${funcName}`,
      params,
      value: 0n,
    })
  }

  // Also look for direct MCD contract calls
  const directPattern = /(\w+)\.file\s*\(\s*"([^"]+)"\s*,\s*([^)]+)\)/g
  while ((match = directPattern.exec(source)) !== null) {
    actions.push({
      target: spellAddress,
      signature: `${match[1]}.file("${match[2]}", ...)`,
      params: {
        functionName: 'file',
        contract: match[1],
        what: match[2],
        value: match[3].trim(),
      },
      value: 0n,
    })
  }

  return actions
}

/**
 * Parse comma-separated arguments, handling nested parentheses and strings.
 */
function parseArgs(argsStr: string): string[] {
  const args: string[] = []
  let current = ''
  let depth = 0
  let inString = false
  let stringChar = ''

  for (const ch of argsStr) {
    if (inString) {
      current += ch
      if (ch === stringChar) inString = false
      continue
    }

    if (ch === '"' || ch === "'") {
      inString = true
      stringChar = ch
      current += ch
      continue
    }

    if (ch === '(' || ch === '[') {
      depth++
      current += ch
      continue
    }

    if (ch === ')' || ch === ']') {
      depth--
      current += ch
      continue
    }

    if (ch === ',' && depth === 0) {
      const trimmed = current.trim()
      if (trimmed) args.push(trimmed)
      current = ''
      continue
    }

    current += ch
  }

  const trimmed = current.trim()
  if (trimmed) args.push(trimmed)

  return args
}

/**
 * Assign named parameters based on known DssExecLib function signatures.
 */
function assignNamedParams(
  funcName: string,
  args: string[],
  params: Record<string, unknown>,
): void {
  switch (funcName) {
    case 'setIlkDebtCeiling':
      params.ilk = args[0]
      params.debtCeiling = args[1]
      break

    case 'setIlkAutoLineParameters':
      params.ilk = args[0]
      params.maxLine = args[1]
      params.gap = args[2]
      params.ttl = args[3]
      break

    case 'setIlkStabilityFee':
      params.ilk = args[0]
      params.stabilityFee = args[1]
      params.doDrip = args[2]
      break

    case 'setDSR':
      params.dsr = args[0]
      params.doDrip = args[1]
      break

    case 'setIlkLiquidationRatio':
      params.ilk = args[0]
      params.liquidationRatio = args[1]
      break

    case 'setIlkLiquidationPenalty':
      params.ilk = args[0]
      params.penalty = args[1]
      break

    case 'increaseIlkDebtCeiling':
    case 'decreaseIlkDebtCeiling':
      params.ilk = args[0]
      params.amount = args[1]
      break
  }
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Fetch and parse a MakerDAO executive spell.
 */
export async function fetchAndParseSpell(spellAddress: string): Promise<DecodedAction[]> {
  log.info({ spellAddress }, 'Fetching and parsing Maker spell')

  const source = await fetchEtherscanSource(spellAddress)
  if (!source) {
    log.warn({ spellAddress }, 'Could not fetch spell source')
    return []
  }

  const actions = parseSpellSource(source, spellAddress)
  log.info({ spellAddress, actionCount: actions.length }, 'Parsed Maker spell')
  return actions
}

/**
 * Get the impact category for a DssExecLib function.
 */
export function getDssExecLibCategory(funcName: string): ImpactCategory {
  return DSSEXECLIB_CATEGORIES[funcName] ?? 'other'
}
