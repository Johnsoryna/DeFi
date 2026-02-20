/**
 * Snapshot GraphQL API client.
 * Free without API key: 100 req/min.
 * With API key: 2M req/month (key available at https://docs.snapshot.box/tools/api/api-keys).
 */
import { createLogger } from '../lib/logger.js'
import { withRetry, rateLimited } from '../lib/retry.js'
import { APIS } from '../config/addresses.js'

const _log = createLogger('snapshot-client')

// Rate limit: ~1 req/sec to stay within 100/min (no API key)
const snapshotFetch = rateLimited(
  async (query: string, variables: Record<string, unknown> = {}): Promise<unknown> => {
    return withRetry(
      async () => {
        const res = await fetch(APIS.snapshotGraphql, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables }),
        })
        if (!res.ok) throw new Error(`Snapshot API ${res.status}`)
        const data = (await res.json()) as { data: unknown; errors?: Array<{ message: string }> }
        if (data.errors) throw new Error(`Snapshot GraphQL: ${JSON.stringify(data.errors)}`)
        return data.data
      },
      'snapshot-graphql',
      { maxRetries: 2, baseDelayMs: 3000 },
    )
  },
  1100,
)

// ─── Query Methods ──────────────────────────────────────────────────

export interface SnapshotProposal {
  id: string
  title: string
  body: string
  choices: string[]
  start: number
  end: number
  snapshot: string
  state: string
  author: string
  scores: number[]
  scores_total: number
  space: { id: string; name: string }
}

export async function getActiveProposals(spaces: string[]): Promise<SnapshotProposal[]> {
  const data = await snapshotFetch(
    `query($spaces: [String!]!) {
      proposals(
        first: 20,
        where: { space_in: $spaces, state: "active" },
        orderBy: "created", orderDirection: desc
      ) {
        id title body choices start end snapshot state author
        scores scores_total
        space { id name }
      }
    }`,
    { spaces },
  )
  const result = data as Record<string, unknown>
  return (result.proposals ?? []) as SnapshotProposal[]
}

export async function getProposal(proposalId: string): Promise<SnapshotProposal | null> {
  const data = await snapshotFetch(
    `query($id: String!) {
      proposal(id: $id) {
        id title body choices start end snapshot state author
        scores scores_total
        space { id name }
      }
    }`,
    { id: proposalId },
  )
  const result = data as Record<string, unknown>
  return (result.proposal ?? null) as SnapshotProposal | null
}

export interface SnapshotVote {
  id: string
  voter: string
  choice: number | number[]
  vp: number
  created: number
}

export async function getVotes(
  proposalId: string,
  first: number = 100,
): Promise<SnapshotVote[]> {
  const data = await snapshotFetch(
    `query($proposal: String!, $first: Int!) {
      votes(
        first: $first,
        where: { proposal: $proposal },
        orderBy: "vp", orderDirection: desc
      ) {
        id voter choice vp created
      }
    }`,
    { proposal: proposalId, first },
  )
  const result = data as Record<string, unknown>
  return (result.votes ?? []) as SnapshotVote[]
}

export async function getVotingPower(
  voter: string,
  space: string,
  proposal: string,
): Promise<number> {
  const data = await snapshotFetch(
    `query($voter: String!, $space: String!, $proposal: String!) {
      vp(voter: $voter, space: $space, proposal: $proposal) {
        vp
      }
    }`,
    { voter, space, proposal },
  )
  const result = data as Record<string, Record<string, number>>
  return result.vp?.vp ?? 0
}
