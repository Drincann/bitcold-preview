import { IncomingMessage } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { Server } from "http";
import pty from "node-pty";
import { logger } from "../lib/logger";

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
    logger.info("Terminal WebSocket connected");

    const cols = 80;
    const rows = 24;

    const shell = pty.spawn("bash", [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.env.HOME ?? "/tmp",
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
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
    });

    ws.on("error", (err) => {
      logger.error({ err }, "Terminal WebSocket error");
      shell.kill();
    });
  });

  logger.info("Terminal WebSocket server attached");
}
