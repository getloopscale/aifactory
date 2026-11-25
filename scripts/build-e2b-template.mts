// Builds the E2B template the factory's sandboxes start from, out of the same Dockerfile the Docker provider
// uses, so an agent finds the same tools on either. Run it again after changing ops/sandbox/Dockerfile, and
// bump the tag in E2B_TEMPLATE (e2b-sandbox.ts) with it:
//
//   node --env-file=.env.local scripts/build-e2b-template.mts
//
// Reads E2B_API_KEY from the environment and prints the template's name and id.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Template } from 'e2b'

import {
  E2B_BROWSER_TEMPLATE,
  E2B_TEMPLATE,
  E2B_TEMPLATE_RESOURCES,
} from '../src/server/factory/e2b-template.ts'

// `--browser` builds the variant with a headless browser (ops/sandbox/Dockerfile.browser) under its own name.
const browser = process.argv.includes('--browser')
const dockerfile = fileURLToPath(new URL('../ops/sandbox/Dockerfile', import.meta.url))
const extra = fileURLToPath(new URL('../ops/sandbox/Dockerfile.browser', import.meta.url))
// E2B has no image to build on, so the browser variant is the default Dockerfile followed by the lines of the
// browser one after its ARG and FROM.
const content = browser
  ? `${readFileSync(dockerfile, 'utf8')}\n${readFileSync(extra, 'utf8')
      .split('\n')
      .filter((line) => !/^(ARG|FROM) /.test(line))
      .join('\n')}`
  : readFileSync(dockerfile, 'utf8')
const template = Template().fromDockerfile(content)

const built = await Template.build(template, browser ? E2B_BROWSER_TEMPLATE : E2B_TEMPLATE, {
  ...E2B_TEMPLATE_RESOURCES,
  onBuildLogs: (entry) => console.log(String(entry)),
})
console.log(JSON.stringify({ name: built.name, templateId: built.templateId, tags: built.tags }))
