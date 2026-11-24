import type { Finding } from './review'
import { issueNamesModule, moduleStem, TEST_FILE, testWeakening } from './test-weakening'

export type Change = { status: string; path: string }

/** One line of `git diff --name-status`: a status letter, then the path (a rename lists two). */
export function parseNameStatus(output: string): Change[] {
  return output
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((parts) => parts.length >= 2 && parts[0] !== '')
    .map((parts) => ({ status: parts[0][0], path: parts[parts.length - 1] }))
}

/** The `test` script of a package.json, or nothing when there is no file, no script or no JSON. */
export function testScriptOf(packageJson: string | undefined): string | undefined {
  if (!packageJson) return undefined
  try {
    const script = (JSON.parse(packageJson) as { scripts?: { test?: unknown } }).scripts?.test
    return typeof script === 'string' ? script : undefined
  } catch {
    return undefined
  }
}

/**
 * Facts about a diff that a person would want to know, and an agent can bend. They do not depend
 * on a model: an agent that edits the command the checks run, or deletes the tests, makes
 * a green check mean nothing, and a reviewer may miss it.
 */
export function diffGuards(input: {
  changes: Change[]
  baseTestScript?: string
  headTestScript?: string
  /** `git diff -U0` of the test files, with the issue it is for: what the change took from the tests. */
  tests?: { patch: string; issue: { labels: string[]; title: string; body: string } }
}): Finding[] {
  const findings: Finding[] = []
  for (const { path } of input.changes.filter((c) => c.path.startsWith('.github/'))) {
    findings.push({ severity: 'blocker', file: path, issue: 'the change touches .github/' })
  }
  if (input.baseTestScript !== input.headTestScript) {
    findings.push({
      severity: 'blocker',
      file: 'package.json',
      issue: `the "test" script was changed (from ${JSON.stringify(input.baseTestScript ?? null)} to ${JSON.stringify(input.headTestScript ?? null)}); the checks now run something else`,
    })
  }
  const deletedModules = input.changes
    .filter((c) => c.status === 'D' && !TEST_FILE.test(c.path))
    .map((c) => c.path)
  for (const { path } of input.changes.filter((c) => c.status === 'D' && TEST_FILE.test(c.path))) {
    findings.push(deletedTest(path, deletedModules, input.tests?.issue))
  }
  if (input.tests) findings.push(...testWeakening(input.tests))
  return findings
}

/**
 * A deleted test file is major, unless the change deletes the module of the same name and the issue names
 * that module: then the tests went with the code the issue removes, and the reviewer judges whether their
 * cases are still covered.
 */
function deletedTest(
  path: string,
  deletedModules: string[],
  issue: { labels: string[]; title: string; body: string } | undefined,
): Finding {
  const stem = moduleStem(path)
  const module = deletedModules.find((m) => moduleStem(m) === stem)
  if (module && issue && issueNamesModule(issue, stem)) {
    return {
      severity: 'minor',
      file: path,
      issue: `a test file was deleted with ${module}, which the issue names; judge whether its cases are still covered`,
    }
  }
  return { severity: 'major', file: path, issue: 'a test file was deleted' }
}
