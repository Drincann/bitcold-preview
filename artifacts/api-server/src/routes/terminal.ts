import { IncomingMessage } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { Server } from "http";
import pty from "node-pty";
import { logger } from "../lib/logger";
import fs from "fs";
import path from "path";
import crypto from "crypto";

function createSessionHome(): string {
  const sessionId = crypto.randomUUID();
  const sessionHome = path.join("/tmp", "sessions", sessionId);
  fs.mkdirSync(sessionHome, { recursive: true });
  return sessionHome;
}

function writeSessionRcFile(sessionHome: string): string {
  const rcFile = path.join(sessionHome, ".session_bashrc");
  const content = `
# Sandboxed session environment
export SESSION_HOME="${sessionHome}"
export HOME="${sessionHome}"
export HISTFILE="${sessionHome}/.bash_history"
export PS1='\\[\\033[1;32m\\][sandbox]\\[\\033[0m\\] \\[\\033[1;34m\\]\\w\\[\\033[0m\\]\\$ '

cd "${sessionHome}"

# Block dangerous commands that affect the host system
_deny() {
  echo "bash: \$1: not available in this environment" >&2
  return 1
}

sudo()    { _deny sudo; }
su()      { _deny su; }
chmod()   {
  for a in "\$@"; do
    case "\$a" in -*) continue;; esac
    local r
    r=\$(realpath -m "\$a" 2>/dev/null || echo "\$a")
    if [[ "\${r#\${SESSION_HOME}}" == "\$r" && "\$r" == /* ]]; then
      echo "chmod: cannot change permissions outside sandbox: \$a" >&2
      return 1
    fi
  done
  command chmod "\$@"
}
chown()   { _deny chown; }
dd()      { _deny dd; }
mkfs()    { _deny mkfs; }
fdisk()   { _deny fdisk; }
shred()   { _deny shred; }
mount()   { _deny mount; }
umount()  { _deny umount; }
sysctl()  { _deny sysctl; }
insmod()  { _deny insmod; }
rmmod()   { _deny rmmod; }
iptables(){ _deny iptables; }
useradd() { _deny useradd; }
userdel() { _deny userdel; }
passwd()  { _deny passwd; }

rm() {
  local -a fargs=()
  local -a paths=()
  local dashdash=false
  for a in "\$@"; do
    if \$dashdash; then
      paths+=("\$a")
    elif [[ "\$a" == "--" ]]; then
      dashdash=true
    elif [[ "\$a" == -* ]]; then
      fargs+=("\$a")
    else
      paths+=("\$a")
    fi
  done
  for p in "\${paths[@]}"; do
    local r
    r=\$(realpath -m "\$p" 2>/dev/null || echo "\$p")
    if [[ "\${r#\${SESSION_HOME}}" == "\$r" && "\$r" == /* ]]; then
      echo "rm: cannot remove '\$p': outside sandbox" >&2
      return 1
    fi
    if [[ "\$r" == "\${SESSION_HOME}" ]]; then
      echo "rm: cannot remove sandbox root '\$p'" >&2
      return 1
    fi
  done
  command rm "\${fargs[@]}" "\${paths[@]}"
}

export -f sudo su chmod chown dd mkfs fdisk shred mount umount sysctl insmod rmmod iptables useradd userdel passwd rm _deny
`;
  fs.writeFileSync(rcFile, content, { mode: 0o600 });
  return rcFile;
}

function cleanupSessionHome(sessionHome: string) {
  try {
    fs.rmSync(sessionHome, { recursive: true, force: true });
    logger.info({ sessionHome }, "Session home cleaned up");
  } catch (err) {
    logger.warn({ err, sessionHome }, "Failed to clean up session home");
  }
}

export function setupTerminalWebSocket(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/api/terminal") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (ws: WebSocket) => {
    const sessionHome = createSessionHome();
    const rcFile = writeSessionRcFile(sessionHome);
    logger.info({ sessionHome }, "Terminal WebSocket connected, sandboxed session created");

    const cols = 80;
    const rows = 24;

    const shell = pty.spawn("bash", ["--rcfile", rcFile], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: sessionHome,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        HOME: sessionHome,
        HISTFILE: path.join(sessionHome, ".bash_history"),
      },
    });

    shell.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "output", data }));
      }
    });

    shell.onExit(({ exitCode }) => {
      logger.info({ exitCode }, "Terminal process exited");
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "exit", code: exitCode }));
        ws.close();
      }
      cleanupSessionHome(sessionHome);
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "input") {
          shell.write(msg.data);
        } else if (msg.type === "resize") {
          shell.resize(msg.cols, msg.rows);
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on("close", () => {
      logger.info("Terminal WebSocket disconnected");
      shell.kill();
      cleanupSessionHome(sessionHome);
    });

    ws.on("error", (err) => {
      logger.error({ err }, "Terminal WebSocket error");
      shell.kill();
      cleanupSessionHome(sessionHome);
    });
  });

  logger.info("Terminal WebSocket server attached");
}
