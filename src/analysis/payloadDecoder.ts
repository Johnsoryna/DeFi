/**
 * Aave PayloadController decoder.
 *
 * Aave V3 governance uses a payload-based system where proposals contain
 * an IPFS hash pointing to a JSON document with the proposal description
 * and technical details. This module:
 *
 *   1. Converts bytes32 ipfsHash → IPFS CID
 *   2. Fetches proposal metadata from IPFS (via public gateway)
 *   3. Extracts description text for NLP analysis
 *   4. Parses any embedded parameter changes
 *
 * For the backtest, IPFS fetching is optional — we fall back to NLP
 * on the Snapshot title/body which is always available.
 */
import { createLogger } from '../lib/logger.js'
import { withRetry } from '../lib/retry.js'

const log = createLogger('payload-decoder')

// ─── Types ───────────────────────────────────────────────────────────

export interface AaveProposalMetadata {
  title: string
  description: string
  shortDescription?: string
  author?: string
  discussions?: string
  ipfsHash: string
}

// ─── IPFS Gateways ───────────────────────────────────────────────────

const IPFS_GATEWAYS = [
  'https://cloudflare-ipfs.com/ipfs',
  'https://ipfs.io/ipfs',
  'https://gateway.pinata.cloud/ipfs',
]

// ─── bytes32 → IPFS CID conversion ──────────────────────────────────

/**
 * Convert an IPFS hash from bytes32 (as emitted by Aave GovernanceCore)
 * to a usable IPFS CID string.
 *
 * Aave stores IPFS hashes as bytes32 which is the raw SHA-256 digest.
 * To get a CIDv0, we need to prepend the multihash prefix (0x1220).
 * Then base58-encode the result.
 */
export function bytes32ToIpfsCid(bytes32: string): string {
  // Remove 0x prefix
  const hex = bytes32.startsWith('0x') ? bytes32.slice(2) : bytes32

  // Skip empty/zero hashes
  if (!hex || hex === '0'.repeat(64)) return ''

  // Aave uses raw SHA-256 digest stored as bytes32
  // CIDv0 = base58(0x1220 + sha256digest)
  const multihashHex = '1220' + hex
  return base58Encode(Buffer.from(multihashHex, 'hex'))
}

// ─── Simple base58 encoder (Bitcoin alphabet) ────────────────────────

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Encode(buffer: Buffer): string {
  const digits = [0]

  for (let i = 0; i < buffer.length; i++) {
    let carry = buffer[i]
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }

  // Leading zeros
  let result = ''
  for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
    result += BASE58_ALPHABET[0]
  }

  for (let i = digits.length - 1; i >= 0; i--) {
    result += BASE58_ALPHABET[digits[i]]
  }

  return result
}

// ─── IPFS Content Fetching ───────────────────────────────────────────

/**
 * Fetch Aave proposal metadata from IPFS.
 * Tries multiple gateways in sequence with retries.
 */
export async function fetchAaveProposalMetadata(
  ipfsCid: string,
): Promise<AaveProposalMetadata | null> {
  if (!ipfsCid) return null

  for (const gateway of IPFS_GATEWAYS) {
    try {
      const metadata = await withRetry(
        async () => {
          const url = `${gateway}/${ipfsCid}`
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 10_000)

          try {
            const res = await fetch(url, { signal: controller.signal })
            if (!res.ok) throw new Error(`IPFS ${res.status}`)
            const data = await res.json() as Record<string, unknown>

            return {
              title: (data.title as string) ?? '',
              description: (data.description as string) ?? (data.body as string) ?? '',
              shortDescription: (data.shortDescription as string) ?? undefined,
              author: (data.author as string) ?? undefined,
              discussions: (data.discussions as string) ?? undefined,
              ipfsHash: ipfsCid,
            }
          } finally {
            clearTimeout(timeout)
          }
        },
        `ipfs-${ipfsCid.slice(0, 12)}`,
        { maxRetries: 1, baseDelayMs: 500 },
      )

      if (metadata && metadata.title) {
        log.debug({ cid: ipfsCid, title: metadata.title.slice(0, 60) }, 'Fetched IPFS metadata')
        return metadata
      }
    } catch (err) {
      log.debug({ gateway, cid: ipfsCid, err }, 'IPFS gateway failed')
      continue
    }
  }

  log.debug({ cid: ipfsCid }, 'All IPFS gateways failed')
  return null
}

/**
 * Extract parameter changes from Aave proposal description text.
 * Aave proposals often include tables with parameter changes like:
 *   | Parameter | Current | Proposed |
 *   | LTV       | 75%     | 80%      |
 */
export function extractParameterChangesFromText(
  description: string,
): Array<{ parameter: string; current?: string; proposed?: string }> {
  const changes: Array<{ parameter: string; current?: string; proposed?: string }> = []

  // Pattern 1: Markdown table rows
  const tablePattern = /\|\s*([^|]+?)\s*\|\s*(\d+(?:\.\d+)?%?)\s*\|\s*(\d+(?:\.\d+)?%?)\s*\|/g
  let match
  while ((match = tablePattern.exec(description)) !== null) {
    const param = match[1].trim()
    // Skip header rows
    if (param.toLowerCase() === 'parameter' || param.includes('---')) continue
    changes.push({
      parameter: param,
      current: match[2].trim(),
      proposed: match[3].trim(),
    })
  }

  // Pattern 2: "X from Y to Z" or "X: Y → Z"
  const inlinePattern = /\b(LTV|LT|Supply Cap|Borrow Cap|Reserve Factor|Debt Ceiling)\b[:\s]+(\d+(?:\.\d+)?%?)\s*(?:→|->|to)\s*(\d+(?:\.\d+)?%?)/gi
  while ((match = inlinePattern.exec(description)) !== null) {
    changes.push({
      parameter: match[1].trim(),
      current: match[2].trim(),
      proposed: match[3].trim(),
    })
  }

  return changes
}
