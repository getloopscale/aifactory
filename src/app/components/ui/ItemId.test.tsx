// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ItemId } from './ItemId'

afterEach(cleanup)

const id = (container: HTMLElement) => container.querySelector('[data-item-id]') as HTMLElement

describe('the number of an item', () => {
  it('writes the issue number in a label that does not shrink', () => {
    const { container } = render(<ItemId item={{ issueNumber: 637 }} />)

    expect(id(container).textContent).toBe('#637')
    expect(id(container).className).toContain('shrink-0')
    expect(id(container).tagName).toBe('SPAN')
  })

  it("writes another tracker's identifier instead of the local number", () => {
    const { container } = render(
      <ItemId item={{ issueNumber: 3, displayIdentifier: 'ENG-12', repository: 'o/r' }} link />,
    )

    expect(id(container).textContent).toBe('ENG-12')
    // The identifier is not a GitHub issue, so it links nowhere.
    expect(id(container).tagName).toBe('SPAN')
  })

  it('opens the GitHub issue in a new tab when asked to link', () => {
    const { container } = render(
      <ItemId item={{ issueNumber: 637, repository: 'getloopscale/aifactory' }} link />,
    )

    expect(id(container).getAttribute('href')).toBe(
      'https://github.com/getloopscale/aifactory/issues/637',
    )
    expect(id(container).getAttribute('target')).toBe('_blank')
    expect(id(container).getAttribute('rel')).toBe('noreferrer')
  })

  it('stays plain text without a repository to link to', () => {
    const { container } = render(<ItemId item={{ issueNumber: 637 }} link />)

    expect(id(container).tagName).toBe('SPAN')
  })
})
