/**
 * Snapshot GraphQL API client.
 * Free, no API key. Rate limit: 60 req/min.
 */
import { createLogger } from '../lib/logger.js'
import { withRetry, rateLimited } from '../lib/retry.js'
import { APIS } from '../config/addresses.js'

const log = createLogger('snapshot-client')

// Rate limit: ~1 req/sec to stay within 60/min
const snapshotFetch = rateLimited(
  async (query: string, variables: Record<string, unknown> = {}): Promise<any> => {
    return withRetry(
      async () => {
        const res = await fetch(APIS.snapshotGraphql, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables }),
        })
        if (!res.ok) throw new Error(`Snapshot API ${res.status}`)
        const data = (await res.json()) as { data: any; errors?: any[] }
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
  return data.proposals ?? []
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
  return data.proposal ?? null
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
  return data.votes ?? []
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
  return data.vp?.vp ?? 0
}
