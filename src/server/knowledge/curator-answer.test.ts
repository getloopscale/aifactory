import { readdirSync, readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { groupKey, parseAnswer } from './curator-answer'
import type { CuratedNote } from './format'

const note = (n: number, taskId: number): CuratedNote => ({
  path: `memory/projects/acme/app/2026-11-06-learned-${n}.md`,
  title: `Note ${n}`,
  description: '',
  generatedAt: '2026-11-06T12:00:00.000Z',
  staleAfter: '2027-05-05T12:00:00.000Z',
  body: `body ${n}`,
  taskIds: [taskId],
  sources: [],
})
const notes = [note(1, 1), note(2, 2), note(3, 3), note(4, 3)]
const answer = (groups: unknown) => JSON.stringify({ groups })
const group = (over: object) => ({
  action: 'merge',
  notes: ['n1', 'n2'],
  title: 'T',
  text: 'Text',
  ...over,
})

describe('the answer of the curator', () => {
  it('takes a merge, a promotion of three tasks and a keep', () => {
    const wide = [1, 2, 3, 4, 5, 6].map((n) => note(n, n))
    const parsed = parseAnswer(
      answer([
        group({}),
        group({ action: 'promote', notes: ['n3', 'n4', 'n5'] }),
        group({ action: 'keep', notes: ['n6'], title: '', text: '' }),
      ]),
      wide,
    )
    expect('groups' in parsed && parsed.groups.map((g) => g.action)).toEqual([
      'merge',
      'promote',
      'keep',
    ])
  })

  it('takes a reply in a code fence', () => {
    expect(parseAnswer('```json\n' + answer([group({})]) + '\n```', notes)).toHaveProperty('groups')
  })

  it.each([
    ['text that is not JSON', 'sure, merged'],
    ['no groups list', '{}'],
    ['an action outside the set', answer([group({ action: 'delete' })])],
    ['a note that does not exist', answer([group({ notes: ['n1', 'n9'] })])],
    ['a note in two groups', answer([group({}), group({ notes: ['n2', 'n3'] })])],
    ['a merge of one note', answer([group({ notes: ['n1'] })])],
    ['a merge with no text', answer([group({ text: '' })])],
    [
      'a promotion of notes from two tasks',
      answer([group({ action: 'promote', notes: ['n1', 'n3', 'n4'] })]),
    ],
  ])('is an error for %s', (_, response) => {
    expect(parseAnswer(response, notes)).toHaveProperty('error')
  })

  it('names a group by its action and notes, whatever the order', () => {
    expect(groupKey('merge', ['a', 'b'])).toBe(groupKey('merge', ['b', 'a']))
    expect(groupKey('merge', ['a', 'b'])).not.toBe(groupKey('promote', ['a', 'b']))
  })
})

describe('what the curator may call', () => {
  const files = [
    ...readdirSync('src/server/knowledge')
      .filter((f) => /^curator.*\.ts$/.test(f) && !f.endsWith('.test.ts'))
      .map((f) => `src/server/knowledge/${f}`),
    'src/server/crons/knowledge-curator.ts',
    'src/server/agents/prompts/curator.ts',
  ]

  it('merges nothing on the knowledge repository: it only opens a pull request', () => {
    expect(files.length).toBeGreaterThan(4)
    for (const file of files) {
      expect({
        file,
        merges: /mergePullRequest|autoMerge|AutoMerge|enablePullRequest/.test(
          readFileSync(file, 'utf8'),
        ),
      }).toEqual({ file, merges: false })
    }
    const sync = readFileSync('src/server/knowledge/sync.ts', 'utf8')
    expect(sync).not.toMatch(/mergePullRequest|autoMerge|AutoMerge/)
  })

  it('pushes nothing: knowledge-sync is the only writer', () => {
    for (const file of files) {
      expect({
        file,
        pushes: /mirror\.(push|commit|setHead)\(/.test(readFileSync(file, 'utf8')),
      }).toEqual({
        file,
        pushes: false,
      })
    }
  })
})
