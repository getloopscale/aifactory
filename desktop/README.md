# aifactory desktop

A packaged client of the panel (Electron). It holds no factory logic: a window on the panel and a tray that shows how many inbox items wait. The server stays a service on one machine.

## Run

```
pnpm install
node desktop/node_modules/electron/install.js   # once: downloads the Electron binary
pnpm --filter desktop start
```

The install does not download the binary (`electron: false` in `pnpm-workspace.yaml`), so a frozen install needs no network.

On first start it asks for the panel's address and checks it by reading `/api/health`; the address is kept in the user's data directory (`settings.json`). Sign in to the panel in the window as usual. The tray reads `/api/panel/inbox` with the window's session every 30 seconds, notifies about new items and opens their task. Closing the window keeps the app in the tray; "Start at login" is in the tray menu, off by default.

The window loads the panel's origin only; any other `http(s)` link opens in the system browser, and `file:` or `javascript:` is refused. If the server does not answer, the window offers to try again or change the address.

## Test

```
pnpm --filter desktop typecheck
pnpm --filter desktop test
```

The logic in `src/logic/` is pure and its tests never import `electron`.

## Build an installer locally

```
pnpm --filter desktop dist
```

The output is in `desktop/dist/installer`. Nothing is published and there is no automatic update.
