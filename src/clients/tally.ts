/**
 * Tally GraphQL API client.
 * Requires free API key. Rate limit: ~1 req/sec.
 */
import { createLogger } from '../lib/logger.js'
import { withRetry, rateLimited } from '../lib/retry.js'
import { APIS } from '../config/addresses.js'
import { config } from '../config/index.js'

const log = createLogger('tally')

const tallyFetch = rateLimited(
  async (query: string, variables: Record<string, unknown> = {}): Promise<any> => {
    if (!config.tallyApiKey) {
      log.warn('Tally API key not configured — skipping')
      return null
    }

    return withRetry(
      async () => {
        const res = await fetch(APIS.tallyGraphql, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Api-Key': config.tallyApiKey!,
          },
          body: JSON.stringify({ query, variables }),
        })
        if (!res.ok) throw new Error(`Tally API ${res.status}`)
        const data = (await res.json()) as { data: any; errors?: any[] }
        if (data.errors) throw new Error(`Tally GraphQL: ${JSON.stringify(data.errors)}`)
        return data.data
      },
      'tally-graphql',
      { maxRetries: 2, baseDelayMs: 3000 },
    )
  },
  1100,
)

// ─── Types ──────────────────────────────────────────────────────────

export interface TallyProposal {
  id: string
  title: string
  description: string
  status: string
  createdAt: string
  startBlock: string
  endBlock: string
  forVotes: string
  againstVotes: string
  abstainVotes: string
  governor: { id: string; name: string }
}

export interface TallyDelegate {
  address: string
  votingPower: string
  delegatorsCount: number
}

// ─── Query Methods ──────────────────────────────────────────────────

export async function getProposals(governorId: string): Promise<TallyProposal[]> {
  const data = await tallyFetch(
    `query($governorId: AccountID!) {
      proposals(governorId: $governorId, sort: { field: CREATED_AT, order: DESC }, first: 10) {
        nodes {
          id title description status createdAt
          startBlock endBlock
          forVotes againstVotes abstainVotes
          governor { id name }
        }
      }
    }`,
    { governorId },
  )

  return data?.proposals?.nodes ?? []
}

export async function getDelegates(
  governorId: string,
  first: number = 20,
): Promise<TallyDelegate[]> {
  const data = await tallyFetch(
    `query($governorId: AccountID!, $first: Int!) {
      delegates(governorId: $governorId, sort: { field: VOTING_POWER, order: DESC }, first: $first) {
        nodes {
          account { address }
          votingPower
          delegatorsCount
        }
      }
    }`,
    { governorId, first },
  )

  return (data?.delegates?.nodes ?? []).map((n: any) => ({
    address: n.account.address,
    votingPower: n.votingPower,
    delegatorsCount: n.delegatorsCount,
  }))
}
