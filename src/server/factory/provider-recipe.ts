import { expect } from 'vitest'

/**
 * One small recipe both sandbox providers run in their end-to-end suites, so a recipe that passes on one is
 * shown to pass on the other. A repository's tests start children with only PATH and HOME, so every step is a
 * child that dropped the environment: it must still reach an allowed domain over https with the tools of the
 * image, be refused for an unlisted one, and find the package manager the repository declares.
 *
 * The sandbox's egress must list registry.npmjs.org and nothing else it uses here.
 */
type Run = (command: string) => Promise<{ stdout: string; exitCode: number }>

const bare = (command: string) => `env -i PATH="$PATH" HOME="$HOME" ${command}`
const node = (url: string) =>
  `node -e "fetch('${url}').then(r => console.log(r.status), () => console.log('refused'))"`

export async function expectSmallRecipe(sh: Run): Promise<void> {
  const allowed = 'https://registry.npmjs.org/left-pad'
  expect((await sh(bare(node(allowed)))).stdout.trim(), 'node, allowed').toBe('200')
  expect(
    (await sh(bare(`curl -s -m 20 -o /dev/null -w "%{http_code}" ${allowed}`))).stdout,
    'curl, allowed',
  ).toBe('200')
  expect(
    (
      await sh(
        bare(
          `python3 -c "import urllib.request as u; print(u.urlopen('${allowed}', timeout=20).status)"`,
        ),
      )
    ).stdout.trim(),
    'python, allowed',
  ).toBe('200')

  expect((await sh(bare(node('https://example.com')))).stdout.trim(), 'node, refused').not.toBe(
    '200',
  )
  expect(
    (await sh(bare('curl -s -m 15 -o /dev/null https://example.com'))).exitCode,
    'curl, refused',
  ).not.toBe(0)

  // Plain HTTP, which has no SNI: the Host header says where it goes. An allowed host answers (the registry
  // redirects to https, which is an answer) and an unlisted one is refused, as a refusal or a connection that fails.
  const code = (url: string) => sh(bare(`curl -s -m 20 -o /dev/null -w "%{http_code}" ${url}`))
  expect(['200', '301', '308']).toContain((await code('http://registry.npmjs.org/left-pad')).stdout)
  expect(['000', '403'], 'http, refused').toContain((await code('http://example.com/')).stdout)

  // The package manager the repository declares, fetched by a child with no COREPACK_HOME.
  const pnpm = await sh(
    `mkdir -p /tmp/recipe && cd /tmp/recipe && echo '{"packageManager":"pnpm@10.34.1"}' > package.json && ${bare('pnpm --version')}`,
  )
  expect(pnpm.stdout.trim(), 'pnpm').toBe('10.34.1')
}
