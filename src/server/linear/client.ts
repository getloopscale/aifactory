import type { FetchLike } from '../github/app'
import { gatedLinear } from './rate-limit'

const ENDPOINT = 'https://api.linear.app/graphql'

/** A GraphQL call to Linear with the API key. Host only: no sandbox receives the key or reaches Linear. */
export type LinearQuery = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>

export function createLinearQuery(
  apiKey: string,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): LinearQuery {
  const call = gatedLinear(fetchImpl)
  return async <T>(query: string, variables: Record<string, unknown> = {}) => {
    const response = await call(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: apiKey },
      body: JSON.stringify({ query, variables }),
    })
    if (!response.ok) throw new Error(`Linear answered ${response.status}`)
    const body = (await response.json()) as { data?: T; errors?: { message: string }[] }
    // A GraphQL error is a failure, never an empty result.
    if (body.errors?.length) {
      throw new Error(`Linear refused: ${body.errors.map((e) => e.message).join('; ')}`)
    }
    if (!body.data) throw new Error('Linear answered with no data')
    return body.data
  }
}

type Page<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }

/** Every page of a connection. `read` returns the connection from one page's data. */
export async function allPages<T, D>(
  query: LinearQuery,
  document: string,
  variables: Record<string, unknown>,
  read: (data: D) => Page<T>,
): Promise<T[]> {
  const nodes: T[] = []
  let after: string | null = null
  for (;;) {
    const page: Page<T> = read(await query<D>(document, { ...variables, after }))
    nodes.push(...page.nodes)
    if (!page.pageInfo.hasNextPage) return nodes
    after = page.pageInfo.endCursor
  }
}
