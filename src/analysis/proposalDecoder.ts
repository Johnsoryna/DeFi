/**
 * Proposal calldata decoder.
 * Decodes Governor Bravo, Aave V3, and MakerDAO executive spell proposals
 * into structured action lists.
 */
import {
  decodeFunctionData,
  encodePacked,
  keccak256,
  toBytes,
  concat,
  type Hex,
} from 'viem'
import { getReadClient } from '../clients/rpc.js'
import { governorBravoAbi } from '../config/abis/governorBravo.js'
import { aavePoolConfiguratorAbi } from '../config/abis/aavePoolConfigurator.js'
import { compoundConfiguratorAbi } from '../config/abis/compoundComet.js'
import { createLogger } from '../lib/logger.js'
import { config } from '../config/index.js'
import { withRetry } from '../lib/retry.js'
import type { DecodedAction, ProposalCreatedEvent } from '../types/governance.js'

const log = createLogger('proposal-decoder')

// ─── Known ABIs for Target Contracts ────────────────────────────────

/** Collect all known function ABIs for decoding proposal calldata */
const KNOWN_ABIS = [
  ...aavePoolConfiguratorAbi,
  ...compoundConfiguratorAbi,
] as const

// ─── Governor Bravo Decoding ────────────────────────────────────────

/**
 * Decode actions from a Governor Bravo ProposalCreated event.
 * The event emits targets[], values[], signatures[], calldatas[] directly.
 */
export function decodeGovernorBravoActions(event: ProposalCreatedEvent): DecodedAction[] {
  const actions: DecodedAction[] = []

  for (let i = 0; i < event.targets.length; i++) {
    const target = event.targets[i]
    const value = event.values[i]
    const signature = event.signatures[i]
    const calldata = event.calldatas[i] as Hex

    let params: Record<string, unknown> = {}

    if (signature) {
      try {
        // Reconstruct full calldata: selector + encoded params
        const selector = keccak256(toBytes(signature)).slice(0, 10) as Hex
        const fullCalldata = concat([selector, calldata])

        // Try to decode using known ABIs
        const funcName = signature.split('(')[0]
        const decoded = tryDecodeFunctionData(funcName, signature, fullCalldata)
        if (decoded) {
          params = decoded
        }
      } catch (err) {
        log.debug({ signature, err }, 'Could not decode calldata — recording raw')
        params = { raw: calldata }
      }
    } else {
      params = { raw: calldata }
    }

    actions.push({ target, signature, params, value })
  }

  return actions
}

/**
 * Decode actions by calling getActions on a Governor Bravo contract.
 */
export async function decodeGovernorBravoProposal(
  governorAddress: `0x${string}`,
  proposalId: bigint,
): Promise<DecodedAction[]> {
  const client = getReadClient()

  const [targets, values, signatures, calldatas] = await client.readContract({
    address: governorAddress,
    abi: governorBravoAbi,
    functionName: 'getActions',
    args: [proposalId],
  }) as [string[], bigint[], string[], Hex[]]

  const actions: DecodedAction[] = []

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]
    const value = values[i]
    const signature = signatures[i]
    const calldata = calldatas[i]

    let params: Record<string, unknown> = {}

    if (signature) {
      try {
        const selector = keccak256(toBytes(signature)).slice(0, 10) as Hex
        const fullCalldata = concat([selector, calldata])
        const funcName = signature.split('(')[0]
        const decoded = tryDecodeFunctionData(funcName, signature, fullCalldata)
        if (decoded) params = decoded
      } catch {
        params = { raw: calldata }
      }
    } else {
      params = { raw: calldata }
    }

    actions.push({ target, signature, params, value })
  }

  return actions
}

// ─── Aave V3 Decoding ──────────────────────────────────────────────

/**
 * Decode Aave V3 proposal payload.
 * Aave proposals contain cross-chain execution payloads via IPFS hash.
 * For on-chain analysis, we check the proposal's execution transaction
 * or fetch payload contracts from the governance payload registry.
 */
export function decodeAavePayload(
  targets: string[],
  calldatas: Hex[],
  signatures: string[],
): DecodedAction[] {
  const actions: DecodedAction[] = []

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]
    const calldata = calldatas[i]
    const signature = signatures[i] ?? ''

    let params: Record<string, unknown> = {}

    if (calldata && calldata.length > 10) {
      // Try decoding with known Aave PoolConfigurator ABIs
      try {
        for (const abiItem of aavePoolConfiguratorAbi) {
          if (abiItem.type !== 'function') continue
          try {
            const result = decodeFunctionData({
              abi: [abiItem],
              data: calldata,
            })
            params = { functionName: result.functionName, args: result.args }
            break
          } catch {
            continue
          }
        }
      } catch {
        params = { raw: calldata }
      }
    }

    actions.push({
      target,
      signature: signature || (params as any).functionName || 'unknown',
      params,
      value: 0n,
    })
  }

  return actions
}

// ─── MakerDAO Spell Parsing ─────────────────────────────────────────

/**
 * Fetch and parse MakerDAO executive spell source code.
 * Spells have an execute() function that calls DssExecLib helpers.
 */
export async function decodeMakerSpell(spellAddress: string): Promise<DecodedAction[]> {
  if (!config.etherscanApiKey) {
    log.warn('Etherscan API key not configured — cannot fetch spell source')
    return []
  }

  try {
    const source = await fetchContractSource(spellAddress)
    if (!source) return []

    return parseDssExecLibCalls(source, spellAddress)
  } catch (err) {
    log.error({ err, spellAddress }, 'Failed to decode Maker spell')
    return []
  }
}

async function fetchContractSource(address: string): Promise<string | null> {
  return withRetry(
    async () => {
      const url = `https://api.etherscan.io/api?module=contract&action=getsourcecode&address=${address}&apikey=${config.etherscanApiKey}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Etherscan ${res.status}`)
      const data = (await res.json()) as { result: Array<{ SourceCode: string }> }
      if (!data.result?.[0]?.SourceCode) return null
      return data.result[0].SourceCode
    },
    `etherscan-source-${address}`,
    { maxRetries: 2, baseDelayMs: 1000 },
  )
}

/**
 * Parse DssExecLib function calls from spell source code.
 * Extracts calls like setIlkDebtCeiling, setIlkStabilityFee, setDSR, etc.
 */
function parseDssExecLibCalls(source: string, spellAddress: string): DecodedAction[] {
  const actions: DecodedAction[] = []

  // Match DssExecLib function calls
  const dssExecLibPattern = /DssExecLib\.(\w+)\(([^)]*)\)/g
  let match

  while ((match = dssExecLibPattern.exec(source)) !== null) {
    const funcName = match[1]
    const argsStr = match[2]

    // Parse argument values (simplified — handles common literal patterns)
    const argValues = argsStr
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)

    const params: Record<string, unknown> = {
      functionName: funcName,
      rawArgs: argValues,
    }

    // Map known DssExecLib functions to their parameter names
    switch (funcName) {
      case 'setIlkDebtCeiling':
        params.ilk = argValues[0]
        params.debtCeiling = argValues[1]
        break
      case 'setIlkStabilityFee':
        params.ilk = argValues[0]
        params.stabilityFee = argValues[1]
        break
      case 'setIlkLiquidationRatio':
        params.ilk = argValues[0]
        params.liquidationRatio = argValues[1]
        break
      case 'setDSR':
        params.dsr = argValues[0]
        break
      case 'setIlkAutoLineParameters':
        params.ilk = argValues[0]
        params.maxLine = argValues[1]
        params.gap = argValues[2]
        params.ttl = argValues[3]
        break
    }

    actions.push({
      target: spellAddress,
      signature: `DssExecLib.${funcName}(${argsStr})`,
      params,
      value: 0n,
    })
  }

  return actions
}

// ─── Helper: Try Decode with Known ABIs ─────────────────────────────

function tryDecodeFunctionData(
  funcName: string,
  signature: string,
  fullCalldata: Hex,
): Record<string, unknown> | null {
  // Build a minimal ABI for this function signature
  try {
    const paramTypes = signature
      .slice(signature.indexOf('(') + 1, signature.lastIndexOf(')'))
      .split(',')
      .filter(Boolean)
      .map((t, i) => ({ name: `param${i}`, type: t.trim() }))

    const minimalAbi = [
      {
        type: 'function' as const,
        name: funcName,
        inputs: paramTypes,
        outputs: [],
        stateMutability: 'nonpayable' as const,
      },
    ]

    const result = decodeFunctionData({ abi: minimalAbi, data: fullCalldata })
    const params: Record<string, unknown> = { functionName: result.functionName }
    if (result.args) {
      for (let i = 0; i < result.args.length; i++) {
        const val = result.args[i]
        params[`param${i}`] = typeof val === 'bigint' ? val.toString() : val
      }
    }
    return params
  } catch {
    return null
  }
}
