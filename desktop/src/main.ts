import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray,
} from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InboxItem } from '../../src/shared/panel'
import { checkAddress } from './logic/address'
import { navigationFor } from './logic/navigation'
import { noticeFor, trayMenu, trayTitle } from './logic/tray'

const POLL_MS = 30_000
const settingsFile = () => join(app.getPath('userData'), 'settings.json')

let origin: string | null = null
let panel: BrowserWindow | null = null
let connect: BrowserWindow | null = null
let tray: Tray | null = null
let items: InboxItem[] = []
let seen: InboxItem[] | null = null
let quitting = false

function loadOrigin(): string | null {
  try {
    const saved = JSON.parse(readFileSync(settingsFile(), 'utf8')) as { origin?: unknown }
    return typeof saved.origin === 'string' ? saved.origin : null
  } catch {
    return null
  }
}

function saveOrigin(next: string): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(settingsFile(), JSON.stringify({ origin: next }))
}

const icon = (name: string) => nativeImage.createFromPath(join(__dirname, '..', 'assets', name))

function guard(win: BrowserWindow): void {
  const decide = (url: string) => (origin ? navigationFor(url, origin) : 'refuse')
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (decide(url) === 'external') void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const where = decide(url)
    if (where === 'stay') return
    event.preventDefault()
    if (where === 'external') void shell.openExternal(url)
  })
}

async function failed(): Promise<void> {
  if (!panel || !origin) return
  const { response } = await dialog.showMessageBox(panel, {
    type: 'warning',
    message: `${origin} did not answer.`,
    buttons: ['Try again', 'Change the address'],
  })
  if (response === 0) void panel.loadURL(origin)
  else askAddress()
}

function openPanel(path = '/'): void {
  if (!origin) return askAddress()
  if (!panel || panel.isDestroyed()) {
    panel = new BrowserWindow({
      width: 1200,
      height: 800,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    guard(panel)
    panel.on('close', (event) => {
      if (quitting) return
      event.preventDefault()
      panel?.hide()
    })
    panel.webContents.on('did-fail-load', (_e, code, _d, _u, isMain) => {
      if (isMain && code !== -3) void failed()
    })
  }
  void panel.loadURL(new URL(path, origin).toString())
  panel.show()
  panel.focus()
}

function askAddress(): void {
  if (connect && !connect.isDestroyed()) return connect.focus()
  connect = new BrowserWindow({
    width: 480,
    height: 240,
    resizable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, 'preload.cjs'),
    },
  })
  connect.setMenu(null)
  connect.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  connect.webContents.on('will-navigate', (event) => event.preventDefault())
  connect.on('closed', () => {
    connect = null
    if (!origin) app.quit()
  })
  void connect.loadFile(join(__dirname, '..', 'assets', 'connect.html'))
}

ipcMain.handle('address:current', () => origin)
ipcMain.handle('address:check', async (event, input: unknown) => {
  if (BrowserWindow.fromWebContents(event.sender) !== connect)
    return { ok: false, reason: 'Not allowed.' }
  const result = await checkAddress(String(input), (url) =>
    fetch(url, { signal: AbortSignal.timeout(10_000) }),
  )
  if (result.ok) {
    origin = result.origin
    saveOrigin(origin)
    seen = null
    items = []
    connect?.close()
    panel?.destroy()
    panel = null
    openPanel()
    void poll()
  }
  return result
})

function render(): void {
  if (!tray) return
  tray.setImage(icon(items.length > 0 ? 'tray-attention.png' : 'tray.png'))
  tray.setToolTip(trayTitle(items.length))
  if (process.platform === 'darwin') tray.setTitle(items.length > 0 ? String(items.length) : '')
  const login = app.getLoginItemSettings().openAtLogin
  const template = trayMenu(items).map((entry): Electron.MenuItemConstructorOptions => {
    if (entry.kind === 'separator') return { type: 'separator' }
    if (entry.kind === 'info') return { label: entry.label, enabled: false }
    if (entry.kind === 'item') return { label: entry.label, click: () => openPanel(entry.path) }
    if (entry.kind === 'toggle') {
      return {
        label: entry.label,
        type: 'checkbox',
        checked: login,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked })
          render()
        },
      }
    }
    const act = {
      open: () => openPanel('/'),
      inbox: () => openPanel('/inbox'),
      address: askAddress,
      quit: () => app.quit(),
    }[entry.id]
    return { label: entry.label, click: act }
  })
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

async function poll(): Promise<void> {
  if (!origin || !panel || panel.isDestroyed()) return
  try {
    const response = await panel.webContents.session.fetch(`${origin}/api/panel/inbox`, {
      credentials: 'include',
    })
    if (!response.ok) return // not signed in, or the server is down: keep what was seen
    const body = (await response.json()) as { items?: InboxItem[] }
    if (!Array.isArray(body.items)) return
    const notice = noticeFor(seen, body.items, Date.now())
    seen = body.items
    items = body.items
    render()
    if (notice && Notification.isSupported()) {
      const shown = new Notification({ title: notice.title, body: notice.body })
      shown.on('click', () => openPanel(notice.path))
      shown.show()
    }
  } catch {
    // unreachable: the window reports it; the baseline stays
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => openPanel())
  app.on('before-quit', () => {
    quitting = true
  })
  app.on('window-all-closed', () => {
    // stays in the tray
  })
  void app.whenReady().then(() => {
    origin = loadOrigin()
    tray = new Tray(icon('tray.png'))
    tray.on('click', () => openPanel())
    render()
    if (origin) openPanel()
    else askAddress()
    setInterval(() => void poll(), POLL_MS)
  })
}
