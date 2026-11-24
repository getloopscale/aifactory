import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/** Names and identifiers that are not a word of either language: the label of GitHub, the product, a code. */
const ALLOWED = new Set(['factory', 'aifactory', 'GitHub', 'Claude', 'Codex', 'OpenRouter'])

/** The attributes whose string a person reads; every other attribute is an identifier, a class or a test id. */
const VISIBLE = new Set(['aria-label', 'title', 'placeholder', 'alt', 'label', 'description'])

const WORDS = /[A-Za-zÀ-ÿ]{2,}/

const visible = (text: string) => WORDS.test(text) && !ALLOWED.has(text.trim())

/** Visible literals of a `.tsx` source: JSX text, string values of the attributes a person reads, and `{'text'}`. */
export function literals(source: string): string[] {
  const file = ts.createSourceFile('x.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[] = []
  const add = (text: string) => {
    if (visible(text)) found.push(text.trim())
  }
  const stringOf = (node: ts.Node | undefined) =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : undefined
  const walk = (node: ts.Node) => {
    if (ts.isJsxText(node)) add(node.text)
    if (ts.isJsxAttribute(node) && VISIBLE.has(node.name.getText(file)) && node.initializer) {
      const init = node.initializer
      const text =
        stringOf(init) ?? (ts.isJsxExpression(init) ? stringOf(init.expression) : undefined)
      if (text !== undefined) add(text)
    }
    if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent)) {
      const text = stringOf(node.expression)
      if (text !== undefined) add(text)
    }
    ts.forEachChild(node, walk)
  }
  walk(file)
  return found
}

/** Every `.tsx` under a folder that is not a test and not the dictionary. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return path === join('src', 'app', 'lib', 'copy') ? [] : sources(path)
    return path.endsWith('.tsx') && !/\.test\.tsx$/.test(path) ? [path] : []
  })
}

describe('no .tsx under src/app has a visible string of its own', () => {
  it('finds a literal when there is one, so the check cannot pass by finding none', () => {
    expect(literals('const a = <p>Nothing here.</p>')).toEqual(['Nothing here.'])
    expect(literals('const a = <div aria-label="Tasks" />')).toEqual(['Tasks'])
    expect(literals("const a = <input placeholder={'Type here'} />")).toEqual(['Type here'])
    expect(literals("const a = <p>{'Hello there'}</p>")).toEqual(['Hello there'])
    expect(literals('const a = <p>{t.board.nothingHere}</p>')).toEqual([])
  })

  it('lets identifiers, class names, test ids and product names through', () => {
    expect(
      literals('const a = <p className="text-sm" data-testid="board-card">factory</p>'),
    ).toEqual([])
    expect(literals('const a = <a href="/work" key="x" role="tab" />')).toEqual([])
    expect(literals('const a = <p>{count} / {total}</p>')).toEqual([])
  })

  const files = sources(join('src', 'app'))

  it('looks at the pages and the components', () => {
    expect(files.length).toBeGreaterThan(40)
  })

  for (const file of files) {
    it(`${file} takes its text from the dictionary`, () => {
      expect(literals(readFileSync(file, 'utf8'))).toEqual([])
    })
  }
})
