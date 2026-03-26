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
    logger.info({ sessionHome }, "Terminal WebSocket connected, session home created");

    const cols = 80;
    const rows = 24;

    const shell = pty.spawn("bash", [], {
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
