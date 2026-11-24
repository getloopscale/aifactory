import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/** Names and identifiers that are not a word of either language: the label of GitHub, the product, a code. */
const ALLOWED = new Set([
  'factory',
  'aifactory',
  'GitHub',
  'Claude',
  'Claude Code',
  'Codex',
  'OpenRouter',
])

/** The attributes whose string a person reads. */
const VISIBLE = new Set(['aria-label', 'title', 'placeholder', 'alt', 'label', 'description'])

/** Attributes that hold an identifier, a class, an address or a style, never a sentence a person reads. */
const TECHNICAL = new Set([
  'className',
  'href',
  'to',
  'type',
  'id',
  'key',
  'role',
  'variant',
  'size',
  'side',
  'align',
  'kind',
  'style',
  'name',
  'value',
  'target',
  'rel',
  'htmlFor',
  'autoComplete',
  'inputMode',
  'method',
  'src',
])

const WORDS = /[A-Za-zÀ-ÿ]{2,}/

/** A string that reads as words: two of them, or a letter only an accented language has. */
const SENTENCE = /[A-Za-zÀ-ÿ]{2,}\s+[A-Za-zÀ-ÿ]{2,}|[À-ÿ]/

/**
 * What a helper sends to an agent is not for the owner to read, and stays as it is: the line that separates
 * the new message from the history, the roles of the history and what a guide is told of where the owner is.
 */
const AGENT_FACING = new Set(['Nova mensagem do dono:\n'])
const AGENT_FACING_FILES = new Set([join('src', 'app', 'lib', 'guides.ts')])
const AGENT_FACING_PREFIXES = [
  'Conversa até aqui',
  'Onde o dono está',
  ' Está com ',
  'The owner then asked',
  'The owner wrote',
]

const sourceOf = (path: string, source: string) =>
  ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

const isText = (node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)

/** Every piece of text in a string, template or conditional expression, wherever it sits inside it. */
function pieces(node: ts.Node, found: string[]) {
  // Elements are walked on their own, and a comparison or an index names something, it does not say it.
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return
  if (ts.isBinaryExpression(node) && /^[!=]==?$/.test(node.operatorToken.getText())) return
  if (ts.isElementAccessExpression(node) || (ts.isPropertyAssignment(node) && false)) return
  if (
    isText(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  ) {
    found.push(node.text)
  }
  ts.forEachChild(node, (child) => pieces(child, found))
}

const words = (text: string) => WORDS.test(text) && !ALLOWED.has(text.trim())

/**
 * Visible literals of a `.tsx` source: JSX text; every string, template and conditional expression that is a
 * child; the value of the attributes a person reads; and any other attribute that is not an identifier, a
 * class or an address.
 */
export function literals(source: string, path = 'x.tsx'): string[] {
  const file = sourceOf(path, source)
  const found: string[] = []
  const walk = (node: ts.Node) => {
    if (ts.isJsxText(node) && words(node.text)) found.push(node.text.trim())
    if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(file)
      const texts: string[] = []
      pieces(node.initializer, texts)
      const reads = VISIBLE.has(name)
      const maybe = !TECHNICAL.has(name) && !name.startsWith('data-') && !name.startsWith('on')
      for (const text of texts) {
        if ((reads && words(text)) || (maybe && SENTENCE.test(text))) found.push(text.trim())
      }
    }
    if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent) && node.expression) {
      const texts: string[] = []
      pieces(node.expression, texts)
      for (const text of texts) {
        const single = isText(node.expression)
        if ((single && words(text)) || (!single && SENTENCE.test(text))) found.push(text.trim())
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(file)
  return [...new Set(found)]
}

/**
 * What a helper under `src/app/lib` says in words: a string of two or more words, or with an accent, that is
 * not an import or a type. What is sent to an agent is not for the owner to read.
 */
export function helperLiterals(source: string, path: string): string[] {
  if (AGENT_FACING_FILES.has(path)) return []
  const file = sourceOf(path, source)
  const found: string[] = []
  const walk = (node: ts.Node) => {
    const parent = node.parent
    const skip =
      parent &&
      (ts.isImportDeclaration(parent) ||
        ts.isExportDeclaration(parent) ||
        ts.isLiteralTypeNode(parent))
    const text =
      !skip &&
      (isText(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node))
        ? node.text
        : undefined
    if (
      text !== undefined &&
      SENTENCE.test(text) &&
      !AGENT_FACING.has(text) &&
      !ALLOWED.has(text.trim()) &&
      !AGENT_FACING_PREFIXES.some((prefix) => text.trim().startsWith(prefix.trim()))
    ) {
      found.push(text.trim())
    }
    ts.forEachChild(node, walk)
  }
  walk(file)
  return found
}

/** Every file under a folder with this ending that is not a test and not the dictionary. */
function sources(dir: string, ending: RegExp, deep = true): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return deep && path !== join('src', 'app', 'lib', 'copy') ? sources(path, ending) : []
    }
    return ending.test(path) && !/\.test\.tsx?$/.test(path) ? [path] : []
  })
}

describe('no .tsx under src/app has a visible string of its own', () => {
  it('finds a literal when there is one, so the check cannot pass by finding none', () => {
    expect(literals('const a = <p>Nothing here.</p>')).toEqual(['Nothing here.'])
    expect(literals('const a = <div aria-label="Tasks" />')).toEqual(['Tasks'])
    expect(literals("const a = <input placeholder={'Type here'} />")).toEqual(['Type here'])
    expect(literals("const a = <p>{'Hello'}</p>")).toEqual(['Hello'])
    expect(literals('const a = <p>{t.board.nothingHere}</p>')).toEqual([])
  })

  it('finds a sentence in a conditional, a template or a prop of a component', () => {
    expect(literals("const a = <p>{ok ? 'It worked fine' : 'It did not work'}</p>")).toEqual([
      'It worked fine',
      'It did not work',
    ])
    expect(literals('const a = <p>{`Done in ${n} minutes`}</p>')).toEqual(['Done in'])
    expect(literals('const a = <Metadata description="Talk to the factory." />')).toEqual([
      'Talk to the factory.',
    ])
    expect(literals('const a = <Card detail={err ? t.a : "Could not answer"} />')).toEqual([
      'Could not answer',
    ])
  })

  it('lets identifiers, class names, test ids and product names through', () => {
    expect(
      literals('const a = <p className="text-sm flex" data-testid="board-card">factory</p>'),
    ).toEqual([])
    expect(literals('const a = <a href="/work" key="x" role="tab" />')).toEqual([])
    expect(literals('const a = <p>{count} / {total}</p>')).toEqual([])
    expect(literals("const a = <p className={on ? 'bg-muted text-foreground' : ''} />")).toEqual([])
  })

  const files = sources(join('src', 'app'), /\.tsx$/)

  it('looks at the pages and the components', () => {
    expect(files.length).toBeGreaterThan(40)
  })

  for (const file of files) {
    it(`${file} takes its text from the dictionary`, () => {
      expect(literals(readFileSync(file, 'utf8'), file)).toEqual([])
    })
  }
})

describe('no helper under src/app/lib has words of its own', () => {
  it('finds a sentence in a helper, and lets an identifier or an agent-facing line through', () => {
    expect(helperLiterals("export const a = 'Uma frase aqui'", 'x.ts')).toEqual(['Uma frase aqui'])
    expect(helperLiterals('export const a = `Feito em ${n} minutos`', 'x.ts')).toEqual(['Feito em'])
    expect(helperLiterals("export const a = 'só'", 'x.ts')).toEqual(['só'])
    expect(helperLiterals("import x from 'a b'\nexport const k = 'no_baseline'", 'x.ts')).toEqual(
      [],
    )
    expect(helperLiterals("export const a = 'Nova mensagem do dono:\\n'", 'x.ts')).toEqual([])
  })

  const files = sources(join('src', 'app', 'lib'), /\.ts$/, false)

  for (const file of files) {
    it(`${file} takes its text from the dictionary`, () => {
      expect(helperLiterals(readFileSync(file, 'utf8'), file)).toEqual([])
    })
  }
})
