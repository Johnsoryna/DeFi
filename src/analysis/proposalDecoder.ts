/**
 * Proposal calldata decoder.
 * Decodes Governor Bravo, Aave V3, and MakerDAO executive spell proposals
 * into structured action lists.
 */
import {
  decodeFunctionData,
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
import { fetchAndParseSpell } from './spellParser.js'
import type { DecodedAction, ProposalCreatedEvent } from '../types/governance.js'

const log = createLogger('proposal-decoder')

// ─── Known ABIs for Target Contracts ────────────────────────────────

/** Collect all known function ABIs for decoding proposal calldata */
const _KNOWN_ABIS = [
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
      let decoded = false
      try {
        for (const abiItem of aavePoolConfiguratorAbi) {
          if (abiItem.type !== 'function') continue
          try {
            const result = decodeFunctionData({
              abi: [abiItem],
              data: calldata,
            })
            // Map args to named parameters using ABI input names
            // viem returns args as a tuple, we need named params for the classifier
            params = { functionName: result.functionName }
            if (result.args && abiItem.inputs) {
              for (let j = 0; j < abiItem.inputs.length; j++) {
                const inputName = abiItem.inputs[j].name
                const value = (result.args as readonly unknown[])[j]
                // Store by name (e.g. 'asset', 'ltv', 'newBorrowCap')
                params[inputName] = value
                // Also store by positional key for backward compatibility
                params[`param${j}`] = value
              }
            }
            decoded = true
            break
          } catch {
            continue
          }
        }
        if (!decoded) {
          log.debug({ calldata: calldata.slice(0, 20), target }, 'Failed to decode Aave calldata with known ABIs')
          params = { raw: calldata }
        }
      } catch (err) {
        log.debug({ err, calldata: calldata.slice(0, 20) }, 'Error decoding Aave calldata')
        params = { raw: calldata }
      }
    }

    actions.push({
      target,
      signature: signature || (params as Record<string, unknown>).functionName as string || 'unknown',
      params,
      value: 0n,
    })
  }

  return actions
}

// ─── MakerDAO Spell Parsing ─────────────────────────────────────────

/**
 * Fetch and parse MakerDAO executive spell source code.
 * Delegates to spellParser which handles multi-file Etherscan responses.
 */
export async function decodeMakerSpell(spellAddress: string): Promise<DecodedAction[]> {
  if (!config.etherscanApiKey) {
    log.warn('Etherscan API key not configured — cannot fetch spell source')
    return []
  }

  try {
    return await fetchAndParseSpell(spellAddress)
  } catch (err) {
    log.error({ err, spellAddress }, 'Failed to decode Maker spell')
    return []
  }
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
