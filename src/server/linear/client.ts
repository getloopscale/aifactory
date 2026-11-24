import type { Blocker, ItemComment, ItemRef, WorkItem, WorkSource } from '../work-source/contract'

import { linearGated, type LinearFetch } from './rate-limit'

const ENDPOINT = 'https://api.linear.app/graphql'
const MAX_PAGES = 20

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export function stateOf(type: string | undefined): 'open' | 'closed' | 'unknown' {
  if (type === 'completed' || type === 'canceled') return 'closed'
  return type ? 'open' : 'unknown'
}

export function toWorkItem(ref: ItemRef, i: Json): WorkItem {
  return {
    ref,
    display: i.identifier,
    title: i.title,
    body: i.description ?? '',
    labels: (i.labels?.nodes ?? []).map((l: { name: string }) => l.name),
    state: stateOf(i.state?.type),
    url: i.url,
  }
}

/**
 * Linear as a work source. The API key lives in the host's environment and is passed here; it is sent
 * only to api.linear.app and never reaches a sandbox (which is not given Linear's domain either).
 */
export function createLinearSource(
  apiKey: string,
  fetchImpl: LinearFetch = (url, init) => fetch(url, init),
): WorkSource {
  const gated = linearGated(fetchImpl)

  async function gql(query: string, variables: Json = {}): Promise<Json> {
    const response = await gated(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: apiKey },
      body: JSON.stringify({ query, variables }),
    })
    if (!response.ok) throw new Error(`Linear answered ${response.status}`)
    const json = (await response.json()) as { data?: Json; errors?: { message: string }[] }
    if (json.errors?.length)
      throw new Error(`Linear: ${json.errors.map((e) => e.message).join('; ')}`)
    return json.data ?? {}
  }

  async function pages<T>(
    query: string,
    variables: Json,
    pick: (data: Json) => {
      nodes: T[]
      pageInfo: { hasNextPage: boolean; endCursor: string | null }
    },
  ): Promise<T[]> {
    const out: T[] = []
    let after: string | null = null
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = pick(await gql(query, { ...variables, after }))
      out.push(...page.nodes)
      if (!page.pageInfo.hasNextPage) return out
      after = page.pageInfo.endCursor
    }
    throw new Error('Linear: too many pages')
  }

  let viewerId: string | undefined
  const viewer = async () =>
    (viewerId ??= (await gql('query { viewer { id } }')).viewer.id as string)

  return {
    name: 'linear',
    async read(ref: ItemRef): Promise<WorkItem> {
      const data = await gql(
        `query($id: String!) { issue(id: $id) { id identifier title description url
          state { type } labels { nodes { name } } } }`,
        { id: ref.id },
      )
      return toWorkItem(ref, data.issue)
    },
    async comments(ref) {
      const self = await viewer()
      const nodes = await pages<Json>(
        `query($id: String!, $after: String) { issue(id: $id) { comments(first: 100, after: $after) {
          nodes { id body createdAt user { id name active } } pageInfo { hasNextPage endCursor } } } }`,
        { id: ref.id },
        (d) => d.issue.comments,
      )
      return nodes.map((c): ItemComment => ({
        id: c.id,
        body: c.body,
        authorId: c.user?.id ?? '',
        authorLogin: c.user?.name ?? '',
        createdAt: new Date(c.createdAt),
        // A comment with no user (an app) and one by the API key's own user are never answers.
        trusted: Boolean(c.user?.id) && c.user.id !== self && c.user.active === true,
      }))
    },
    async comment(ref, body) {
      const data = await gql(
        `mutation($id: String!, $body: String!) { commentCreate(input: { issueId: $id, body: $body }) { success comment { id } } }`,
        { id: ref.id, body },
      )
      if (!data.commentCreate?.success) throw new Error('Linear refused the comment')
      return String(data.commentCreate.comment?.id ?? '')
    },
    async blockers(ref): Promise<Blocker[]> {
      const rels = await pages<Json>(
        `query($id: String!, $after: String) { issue(id: $id) { inverseRelations(first: 100, after: $after) {
          nodes { type issue { id identifier state { type } } } pageInfo { hasNextPage endCursor } } } }`,
        { id: ref.id },
        (d) => d.issue.inverseRelations,
      )
      return rels
        .filter((r) => r.type === 'blocks')
        .map((r) => {
          return {
            ref: { source: 'linear' as const, id: r.issue.id as string },
            display: r.issue.identifier as string,
            state: stateOf(r.issue?.state?.type),
          }
        })
    },
    async close(ref) {
      const data = await gql(
        `query($id: String!) { issue(id: $id) { team { states { nodes { id type name position } } } } }`,
        { id: ref.id },
      )
      const done = (data.issue.team.states.nodes as Json[])
        .filter((s) => s.type === 'completed')
        .sort((a, b) => a.position - b.position)
      if (done.length === 0) throw new Error(`Linear: the team of ${ref.id} has no completed state`)
      const moved = await gql(
        `mutation($id: String!, $state: String!) { issueUpdate(id: $id, input: { stateId: $state }) { success } }`,
        { id: ref.id, state: done[0].id },
      )
      if (!moved.issueUpdate?.success) throw new Error('Linear refused to move the item')
    },
  }
}
