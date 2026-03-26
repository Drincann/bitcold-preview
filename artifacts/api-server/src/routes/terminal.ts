import { IncomingMessage } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { Server } from "http";
import pty from "node-pty";
import { logger } from "../lib/logger";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const BITCOLD_BIN = "/home/runner/workspace/.config/npm/node_global/bin/bitcold";

function createSessionHome(): string {
  const sessionId = crypto.randomUUID();
  const sessionHome = path.join("/tmp", "sessions", sessionId);
  fs.mkdirSync(sessionHome, { recursive: true });
  return sessionHome;
}

function writeSessionShell(sessionHome: string): string {
  const shellPath = path.join(sessionHome, ".shell");
  const lines = [
    "#!/bin/bash",
    "stty -echo",
    `export HOME="${sessionHome}"`,
    `export BITCOLD_HOME="${sessionHome}/.bitcold"`,
    `cd "${sessionHome}"`,
    "",
    'RESET="\\033[0m"',
    'BOLD="\\033[1m"',
    'GREEN="\\033[1;32m"',
    'CYAN="\\033[1;36m"',
    'RED="\\033[1;31m"',
    'GRAY="\\033[0;90m"',
    "",
    'printf "\\n${BOLD}${GREEN}bitcold terminal${RESET}\\n"',
    `printf "\${GRAY}Type 'bitcold help' to get started. Type 'exit' to quit.\${RESET}\\n\\n"`,
    "",
    "while true; do",
    '  printf "${GREEN}~${RESET} ${CYAN}❯${RESET}  "',
    "",
    "  full_line=\"\"",
    "  while true; do",
    "    IFS= read -r chunk",
    "    [[ $? -ne 0 ]] && { echo; exit 0; }",
    "    if [[ \"$chunk\" == *\\\\ ]]; then",
    "      full_line+=\"${chunk%\\\\} \"",
    '      printf "${CYAN}❯${RESET}  "',
    "    else",
    "      full_line+=\"$chunk\"",
    "      break",
    "    fi",
    "  done",
    "  line=$(echo \"$full_line\" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')",
    "  [[ -z \"$line\" ]] && continue",
    "",
    '  read -ra parts <<< "$line"',
    '  cmd="${parts[0]}"',
    "",
    '  case "$cmd" in',
    "    exit|quit)",
    '      printf "${GRAY}Goodbye.\\n${RESET}"',
    "      exit 0",
    "      ;;",
    "    clear)",
    "      clear",
    "      ;;",
    "    bitcold)",
    `      "${BITCOLD_BIN}" "\${parts[@]:1}"`,
    "      ;;",
    "    help)",
    '      printf "${BOLD}Available commands:${RESET}\\n"',
    '      printf "  ${CYAN}bitcold <args>${RESET}  — run bitcold\\n"',
    '      printf "  ${CYAN}clear${RESET}           — clear screen\\n"',
    '      printf "  ${CYAN}exit${RESET}            — exit terminal\\n"',
    "      ;;",
    "    *)",
    '      printf "${RED}%s: command not found${RESET}\\n" "$cmd" >&2',
    `      printf "\${GRAY}Only 'bitcold' is available. Type 'help' for usage.\${RESET}\\n" >&2`,
    "      ;;",
    "  esac",
    "done",
  ];
  fs.writeFileSync(shellPath, lines.join("\n") + "\n", { mode: 0o700 });
  return shellPath;
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
    const shellPath = writeSessionShell(sessionHome);
    logger.info({ sessionHome }, "Terminal WebSocket connected, restricted shell created");

    const cols = 80;
    const rows = 24;

    const shell = pty.spawn(shellPath, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: sessionHome,
      env: {
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        HOME: sessionHome,
        PATH: `${path.dirname(BITCOLD_BIN)}:${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
        LANG: process.env.LANG ?? "en_US.UTF-8",
        NODE_PATH: process.env.NODE_PATH ?? "",
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
