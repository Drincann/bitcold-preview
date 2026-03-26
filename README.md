# bitcold Terminal

A web-based terminal for [bitcold](https://github.com/Drincann/bitcold) — a Bitcoin cold wallet CLI tool. Each visitor gets a fully isolated, sandboxed session running the `bitcold` binary directly in the browser.

Designed to be embedded as an iframe in any page, with no setup required from the user.

---

## What it does

- Opens a real PTY (pseudo-terminal) per visitor, isolated to its own temporary home directory
- Runs `bitcold` commands in that PTY — full interactive support including password prompts, QR code output, and inquirer menus
- Restricts the session to only `bitcold`, `clear`, `help`, and `exit` — no shell escape is possible
- Cleans up the session directory automatically on disconnect

## Usage

Visit the deployed app or embed it in an iframe:

```html
<iframe src="https://bitcold-preview.replit.app" width="800" height="600" frameborder="0"></iframe>
```

Available commands inside the terminal:

```
bitcold <args>   — run any bitcold subcommand
help             — show available commands
clear            — clear the screen
exit             — end the session
```

## Development

### Prerequisites

- Node.js 24+
- pnpm 9+

### Install and run

```bash
pnpm install

# Start the API server (WebSocket backend)
pnpm --filter @workspace/api-server run dev

# Start the terminal frontend
pnpm --filter @workspace/terminal run dev
```

The terminal UI will be available at `http://localhost:<PORT>` (port assigned automatically by Replit).

### Upgrade bitcold

Edit the version in `artifacts/api-server/package.json`, then:

```bash
pnpm install
# restart the api-server workflow
```

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite, xterm.js |
| Backend | Node.js 24, Express 5, ws |
| Terminal emulation | node-pty (PTY per session) |
| Monorepo | pnpm workspaces |
| Language | TypeScript 5.9 |

## Architecture

For a detailed breakdown of how the system works — session lifecycle, WebSocket protocol, restricted shell design, and security model — see [docs/architecture.md](docs/architecture.md).

## License

MIT
