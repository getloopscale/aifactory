import { describe, expect, it } from 'vitest'

import { improverPrompt } from '../agents/prompts/improver'

import { IMPROVER_KINDS } from './decide'
import { parseScout } from './scout'

const found = {
  found: true,
  target: 'src/a.ts',
  title: 'Test a',
  body: 'Add a test.',
  evidence: 'No test.',
}

describe('parseScout', () => {
  it('reads a proposal and the answer that found nothing', () => {
    expect(parseScout(`Looked.\n${JSON.stringify(found)}`)).toEqual(found)
    expect(parseScout('{"found":false}')).toEqual({ found: false })
  })

  it('takes the last object', () => {
    expect(parseScout(`${JSON.stringify(found)}\n{"found":false}`)).toEqual({ found: false })
  })

  it.each([
    'I found nothing.',
    '{ broken',
    '{"found":"yes"}',
    JSON.stringify({ ...found, target: '' }),
    JSON.stringify({ ...found, target: '/etc/passwd' }),
    JSON.stringify({ ...found, target: '../x' }),
    JSON.stringify({ ...found, title: '  ' }),
    JSON.stringify({ ...found, body: 3 }),
  ])('is no answer: %s', (answer) => {
    expect(parseScout(answer)).toBeUndefined()
  })

  it('trims a directory’s trailing slash and cuts the title', () => {
    const parsed = parseScout(
      JSON.stringify({ ...found, target: 'src/x/', title: 'T'.repeat(300) }),
    )
    expect(parsed).toMatchObject({ target: 'src/x' })
    expect(parsed && 'title' in parsed && parsed.title).toHaveLength(120)
  })
})

describe('improverPrompt', () => {
  it('has an instruction for every kind and asks for the JSON', () => {
    for (const kind of IMPROVER_KINDS) {
      const prompt = improverPrompt({ repo: 'o/r', kind })
      expect(prompt).toContain('"found":false')
      expect(prompt).toContain('ONE')
    }
    expect(new Set(IMPROVER_KINDS.map((kind) => improverPrompt({ repo: 'o/r', kind }))).size).toBe(
      IMPROVER_KINDS.length,
    )
  })
})
