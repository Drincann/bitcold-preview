# Technical Architecture

## Overview

bitcold Terminal is a web application that gives each browser visitor an isolated, sandboxed session running the `bitcold` CLI binary. The user interacts with it through a full terminal emulator rendered in the browser.

```
Browser
┌─────────────────────────────────────┐
│  xterm.js (terminal renderer)       │
│  ┌───────────────────────────────┐  │
│  │  client-side input buffer     │  │
│  │  local echo / cursor movement │  │
│  └──────────┬────────────────────┘  │
└─────────────│────────────────────────┘
              │ WebSocket (JSON frames)
              │
API Server (Node.js / Express 5)
┌─────────────┴────────────────────────┐
│  /api/terminal  (WebSocket upgrade)  │
│  ┌────────────────────────────────┐  │
│  │  node-pty  ←→  PTY session     │  │
│  │  restricted bash shell         │  │
│  │  HOME = /tmp/sessions/<uuid>/  │  │
│  └──────────┬─────────────────────┘  │
└─────────────│────────────────────────┘
              │ execve
              ▼
         bitcold binary
```

---

## Components

### Frontend — `artifacts/terminal`

React 19 + Vite app. Renders a fullscreen xterm.js terminal with no chrome — designed for iframe embedding.

**Key design choices:**

- **Client-side input buffer**: Typed characters are buffered locally and echoed to the terminal immediately, avoiding visible network latency on every keystroke. The buffer is flushed to the server only on Enter or Ctrl+C.
- **`atShellPrompt` state**: The client tracks whether the shell is at the top-level prompt (waiting for a new command) or inside an interactive program (e.g., inquirer password prompts). This controls whether Enter sends `\r\n` (to make the typed command visible in the scroll buffer) or `\r` only (to avoid interfering with interactive program rendering).
- **Paste handling**: Multi-line pastes joined with backslash continuation (`\`) are reassembled into a single command before submission.
- **Resize**: Terminal dimensions are reported to the server via a `resize` WebSocket message whenever the window resizes; the PTY is resized accordingly.

**WebSocket message protocol (client → server):**

```json
{ "type": "input",  "data": "<string>" }
{ "type": "resize", "cols": 120, "rows": 40 }
```

**WebSocket message protocol (server → client):**

```json
{ "type": "output", "data": "<terminal output string>" }
{ "type": "exit",   "code": 0 }
```

---

### Backend — `artifacts/api-server`

Express 5 server with a WebSocket endpoint at `/api/terminal`.

#### Session lifecycle

```
WebSocket connect
    │
    ├─ createSessionHome()
    │    └─ mkdir /tmp/sessions/<uuid>/
    │
    ├─ writeSessionShell()
    │    └─ write restricted bash script to $HOME/.shell
    │
    ├─ node-pty spawns .shell
    │    └─ TERM=xterm-256color, cols=80, rows=24
    │
    │  [session active]
    │    ├─ PTY output → JSON { type: "output" } → client
    │    └─ client input → shell.write()
    │
    └─ disconnect / shell exit
         ├─ shell.kill()
         └─ rm -rf /tmp/sessions/<uuid>/
```

Each session gets its own UUID directory as `HOME` and `BITCOLD_HOME`. Sessions are completely independent — no shared state between visitors.

#### Restricted shell

Rather than running a real shell, each session executes a purpose-written bash script. The script's command dispatcher is a `case` statement that only recognises four commands:

```bash
case "$cmd" in
  bitcold) "$BITCOLD_BIN" "${parts[@]:1}" ;;
  clear)   clear ;;
  help)    printf "..." ;;
  exit)    exit 0 ;;
  *)       printf "%s: command not found\n" "$cmd" >&2 ;;
esac
```

There is no `eval`, no subshell expansion exposed to user input, and no PATH manipulation that would allow running arbitrary binaries. `stty -echo` is set at startup so the PTY does not double-echo input.

#### bitcold binary resolution

On startup, `resolveBitcoldBin()` resolves the binary path in order:

1. `<api-server>/node_modules/.bin/bitcold` (installed as a direct npm dependency)
2. `which bitcold` in `$PATH` (fallback for custom environments)

The resolved path is logged at startup and injected into the restricted shell as the only allowed executable.

---

## Security model

| Threat | Mitigation |
|---|---|
| Shell escape | Restricted bash `case` dispatcher; no user-controlled `eval` or substitution |
| Cross-session data access | Each session has its own isolated `HOME` in `/tmp/sessions/<uuid>/`; no shared filesystem |
| Session persistence after disconnect | `rm -rf` on disconnect and on shell exit; PTY killed on WebSocket close/error |
| Token / secret leakage | `GITHUB_TOKEN` and other secrets stored as encrypted Replit Secrets; never committed to git |
| Arbitrary binary execution | Only `$BITCOLD_BIN` (resolved at startup) can be executed; PATH inside the shell is restricted |

---

## Monorepo layout

```
/
├── artifacts/
│   ├── api-server/          # Express + WebSocket backend
│   │   └── src/
│   │       ├── index.ts     # HTTP server entry, reads PORT
│   │       ├── app.ts       # Express app, CORS, route mounts
│   │       └── routes/
│   │           ├── index.ts
│   │           ├── health.ts
│   │           └── terminal.ts   # WebSocket + PTY session logic
│   └── terminal/            # React + Vite frontend
│       └── src/
│           └── pages/
│               └── Terminal.tsx  # xterm.js + WebSocket client
├── lib/
│   ├── api-spec/            # OpenAPI 3.1 spec + Orval config
│   ├── api-client-react/    # Generated React Query hooks
│   ├── api-zod/             # Generated Zod schemas
│   └── db/                  # Drizzle ORM + PostgreSQL
├── scripts/
│   ├── github-push.cjs      # GitHub API push helper
│   └── post-merge.sh        # Post-merge setup (pnpm install + db push)
├── docs/
│   └── architecture.md      # This file
└── README.md
```

---

## Data flow — a single command

```
User types "bitcold wallet list" + Enter
    │
    ▼
xterm.js input handler
    │  local echo of each character
    │  Enter detected → atShellPrompt=true → send \r\n
    ▼
WebSocket → { type: "input", data: "bitcold wallet list\r\n" }
    │
    ▼
server: shell.write("bitcold wallet list\r\n")
    │
    ▼
restricted bash reads line → cmd = "bitcold"
    │  runs: /path/to/bitcold wallet list
    ▼
bitcold writes output to PTY
    │
    ▼
node-pty onData callback
    │  ws.send(JSON.stringify({ type: "output", data: "..." }))
    ▼
xterm.js term.write(data)
    │
    ▼
Terminal rendered in browser
```
