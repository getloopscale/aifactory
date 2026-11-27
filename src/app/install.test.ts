import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const read = (file: string) => readFileSync(join(root, file), 'utf8')

describe('the installable panel', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest')) as {
    name: string
    short_name: string
    display: string
    start_url: string
    icons: { src: string; sizes: string; purpose?: string }[]
  }

  it('has a standalone manifest with both icon sizes and a maskable one', () => {
    expect(manifest.name).toBe('aifactory')
    expect(manifest.short_name).toBe('aifactory')
    expect(manifest.display).toBe('standalone')
    expect(manifest.start_url).toBe('/')
    const sizes = manifest.icons.map((i) => i.sizes)
    expect(sizes).toContain('192x192')
    expect(sizes).toContain('512x512')
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true)
    for (const icon of manifest.icons) read(`public${icon.src}`)
  })

  it('links the manifest and names the page aifactory', () => {
    const html = read('index.html')
    expect(html).toContain('<title>aifactory</title>')
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"')
    expect(html).toContain('name="theme-color"')
    expect(html).toContain('rel="apple-touch-icon"')
    expect(html).toContain('name="apple-mobile-web-app-capable"')
    expect(read('public/index.html')).not.toContain('LoopZero App')
  })

  it('has a worker that handles install and activate and registers no fetch handler', () => {
    const worker = read('public/sw.js')
    expect(worker).toContain("addEventListener('install'")
    expect(worker).toContain("addEventListener('activate'")
    expect(worker).not.toMatch(/addEventListener\(\s*['"]fetch['"]/)
    expect(worker).not.toMatch(/onfetch/)
    expect(worker).not.toMatch(/caches\./)
  })

  it('shows a notification per task on push and focuses or opens the link on click', () => {
    const worker = read('public/sw.js')
    expect(worker).toContain("addEventListener('push'")
    expect(worker).toContain('showNotification')
    expect(worker).toMatch(/tag:\s*data\.tag/)
    expect(worker).toContain("addEventListener('notificationclick'")
    expect(worker).toContain('matchAll')
    expect(worker).toContain('openWindow')
  })
})
