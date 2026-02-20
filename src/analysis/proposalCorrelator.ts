/**
 * Proposal Correlator — links Snapshot proposals to on-chain governance events.
 *
 * Aave governance flow: Snapshot vote → On-chain proposal → Timelock → Execution.
 * The Snapshot title often contains the best description of what the proposal does,
 * while the on-chain event has the actual execution payload.
 *
 * This module correlates Snapshot proposals with on-chain proposals by:
 *   1. Protocol matching (same protocol)
 *   2. Time proximity (Snapshot ends before or near on-chain proposal creation)
 *   3. Title similarity (fuzzy matching for keyword overlap)
 */
import { createLogger } from '../lib/logger.js'
import { getClock } from '../backtest/clock.js'
import type {
  SnapshotProposalEvent,
  ProposalCreatedEvent,
  IntelligentAnalysis,
  GovernanceProtocol,
} from '../types/governance.js'

const log = createLogger('correlator')

// ─── Types ───────────────────────────────────────────────────────────

export interface CorrelatedProposal {
  snapshotId: string
  onchainProposalId: string
  protocol: GovernanceProtocol
  correlationScore: number // 0-1 confidence of the match
  snapshotTitle: string
  onchainDescription: string
}

// ─── State: Recent proposals for matching ────────────────────────────

interface ProposalRecord {
  id: string
  protocol: GovernanceProtocol
  title: string
  timestamp: number
  analysis?: IntelligentAnalysis
}

const recentSnapshots: ProposalRecord[] = []
const recentOnchain: ProposalRecord[] = []

const MAX_HISTORY = 200
const CORRELATION_WINDOW_MS = 30 * 24 * 3600_000 // 30 days

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Record a Snapshot proposal for future correlation.
 */
export function recordSnapshot(snap: SnapshotProposalEvent, analysis?: IntelligentAnalysis): void {
  recentSnapshots.push({
    id: snap.snapshotId,
    protocol: snap.protocol,
    title: snap.title,
    timestamp: snap.end * 1000, // Snapshot end time in ms
    analysis,
  })

  // Trim old entries
  if (recentSnapshots.length > MAX_HISTORY) {
    recentSnapshots.splice(0, recentSnapshots.length - MAX_HISTORY)
  }
}

/**
 * Record an on-chain proposal for future correlation.
 */
export function recordOnchain(proposal: ProposalCreatedEvent, analysis?: IntelligentAnalysis): void {
  recentOnchain.push({
    id: proposal.proposalId.toString(),
    protocol: proposal.protocol,
    title: proposal.description.slice(0, 200),
    timestamp: proposal.timestamp ?? getClock().now(),
    analysis,
  })

  if (recentOnchain.length > MAX_HISTORY) {
    recentOnchain.splice(0, recentOnchain.length - MAX_HISTORY)
  }
}

/**
 * Find the best matching Snapshot proposal for an on-chain proposal.
 * Returns the correlation if found, null otherwise.
 */
export function findSnapshotForOnchain(
  proposal: ProposalCreatedEvent,
): CorrelatedProposal | null {
  const proposalTime = proposal.timestamp ?? getClock().now()
  let bestMatch: CorrelatedProposal | null = null
  let bestScore = 0

  for (const snap of recentSnapshots) {
    // Must be same protocol
    if (snap.protocol !== proposal.protocol) continue

    // Time check: Snapshot should end before or around on-chain proposal creation
    const timeDiff = Math.abs(proposalTime - snap.timestamp)
    if (timeDiff > CORRELATION_WINDOW_MS) continue

    // Time proximity score (closer = better)
    const timeScore = 1 - (timeDiff / CORRELATION_WINDOW_MS)

    // Title similarity score
    const titleScore = calculateTitleSimilarity(snap.title, proposal.description)

    // Combined score
    const score = timeScore * 0.3 + titleScore * 0.7

    if (score > bestScore && score > 0.3) {
      bestScore = score
      bestMatch = {
        snapshotId: snap.id,
        onchainProposalId: proposal.proposalId.toString(),
        protocol: proposal.protocol,
        correlationScore: score,
        snapshotTitle: snap.title,
        onchainDescription: proposal.description.slice(0, 200),
      }
    }
  }

  if (bestMatch) {
    log.info(
      {
        snapshotId: bestMatch.snapshotId.slice(0, 12),
        onchainId: bestMatch.onchainProposalId,
        score: bestMatch.correlationScore.toFixed(2),
      },
      'Correlated Snapshot ↔ On-chain proposal',
    )
  }

  return bestMatch
}

/**
 * Get the IntelligentAnalysis from a previously recorded Snapshot,
 * enriching an on-chain proposal with Snapshot-derived NLP insights.
 */
export function getSnapshotAnalysis(snapshotId: string): IntelligentAnalysis | undefined {
  const snap = recentSnapshots.find((s) => s.id === snapshotId)
  return snap?.analysis
}

/**
 * Clear correlation state (for backtest cleanup between runs).
 */
export function resetCorrelator(): void {
  recentSnapshots.length = 0
  recentOnchain.length = 0
}

// ─── Internal: Title Similarity ──────────────────────────────────────

/**
 * Calculate similarity between two proposal titles.
 * Uses Jaccard similarity on significant keywords (ignoring common words).
 */
function calculateTitleSimilarity(title1: string, title2: string): number {
  const words1 = extractSignificantWords(title1)
  const words2 = extractSignificantWords(title2)

  if (words1.size === 0 || words2.size === 0) return 0

  const intersection = new Set([...words1].filter((w) => words2.has(w)))
  const union = new Set([...words1, ...words2])

  return intersection.size / union.size
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'that', 'this', 'these',
  'those', 'it', 'its', 'we', 'they', 'them', 'their', 'our', 'your',
  'arfc', 'temp', 'check', 'proposal', 'update', 'aave', 'v3',
])

function extractSignificantWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))

  return new Set(words)
}
