import type { WorkComment, WorkItem, WorkSource } from '../work-source/contract'
import { allPages, type LinearQuery } from './client'

type IssueNode = {
  id: string
  identifier: string
  url: string
  title: string
  description: string | null
  labels: { nodes: { name: string }[] }
  state: { type: string }
  team: { id: string }
}

const ISSUE = `id identifier url title description labels { nodes { name } } state { type } team { id }`

export type LinearSourceDeps = {
  query: LinearQuery
  /** The Linear user id of the API key's owner: what the factory comments as. Never an answer. */
  factoryUserId: string
}

const CLOSED = new Set(['completed', 'canceled'])

export function linearItem(node: IssueNode): WorkItem {
  return {
    source: 'linear',
    id: node.id,
    identifier: node.identifier,
    url: node.url,
    title: node.title,
    body: node.description ?? '',
    labels: node.labels.nodes.map((l) => l.name),
    state: CLOSED.has(node.state.type) ? 'closed' : 'open',
  }
}

/** Linear behind the work-source contract. */
export function linearWorkSource({ query, factoryUserId }: LinearSourceDeps): WorkSource {
  return {
    kind: 'linear',
    async read(id) {
      const data = await query<{ issue: IssueNode }>(
        `query($id: String!) { issue(id: $id) { ${ISSUE} } }`,
        { id },
      )
      return linearItem(data.issue)
    },
    async listComments(id, since) {
      const nodes = await allPages<
        { id: string; body: string; createdAt: string; user: { id: string; name: string } | null },
        { issue: { comments: never } }
      >(
        query,
        `query($id: String!, $after: String, $since: DateTimeOrDuration!) { issue(id: $id) { comments(first: 100, after: $after, filter: { createdAt: { gt: $since } }) { nodes { id body createdAt user { id name } } pageInfo { hasNextPage endCursor } } } }`,
        { id, since: since.toISOString() },
        (data) => data.issue.comments,
      )
      // Only a member of the workspace has a user; a comment with none (an integration's) is not trusted.
      return nodes
        .map((c): WorkComment => ({
          id: c.id,
          body: c.body,
          author: c.user?.name ?? '',
          createdAt: new Date(c.createdAt),
          trusted: c.user !== null && c.user.id !== factoryUserId,
        }))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    },
    async openBlockers(item) {
      const relations = await allPages<
        { type: string; issue: { identifier: string; state: { type: string } } },
        { issue: { inverseRelations: never } }
      >(
        query,
        `query($id: String!, $after: String) { issue(id: $id) { inverseRelations(first: 100, after: $after) { nodes { type issue { identifier state { type } } } pageInfo { hasNextPage endCursor } } } }`,
        { id: item.id },
        (data) => data.issue.inverseRelations,
      )
      return relations
        .filter((r) => r.type === 'blocks' && !CLOSED.has(r.issue.state.type))
        .map((r) => r.issue.identifier)
    },
    async comment(id, body) {
      const data = await query<{
        commentCreate: { success: boolean; comment: { id: string } | null }
      }>(
        `mutation($id: String!, $body: String!) { commentCreate(input: { issueId: $id, body: $body }) { success comment { id } } }`,
        { id, body },
      )
      if (!data.commentCreate.success || !data.commentCreate.comment) {
        throw new Error('Linear did not create the comment')
      }
      return data.commentCreate.comment.id
    },
    async close(id) {
      const data = await query<{
        issue: { team: { states: { nodes: { id: string; position: number }[] } } }
      }>(
        `query($id: String!) { issue(id: $id) { team { states(filter: { type: { eq: "completed" } }) { nodes { id position } } } } }`,
        { id },
      )
      // The first completed state of the workflow, by position: the same one every time.
      const done = [...data.issue.team.states.nodes].sort((a, b) => a.position - b.position)[0]
      if (!done) throw new Error('The Linear team has no completed state')
      const update = await query<{ issueUpdate: { success: boolean } }>(
        `mutation($id: String!, $state: String!) { issueUpdate(id: $id, input: { stateId: $state }) { success } }`,
        { id, state: done.id },
      )
      if (!update.issueUpdate.success) throw new Error('Linear did not move the item to done')
    },
  }
}

/** Reads what a decision needs of an item, for a webhook that did not carry it. A failure throws. */
export async function readLinearFacts(
  query: LinearQuery,
  itemId: string,
): Promise<import('./ingress').LinearFacts> {
  const data = await query<{ issue: IssueNode }>(
    `query($id: String!) { issue(id: $id) { ${ISSUE} } }`,
    { id: itemId },
  )
  const item = linearItem(data.issue)
  return {
    itemId: item.id,
    identifier: item.identifier,
    url: item.url,
    title: item.title,
    teamId: data.issue.team.id,
    labels: item.labels,
    closed: item.state === 'closed',
  }
}
