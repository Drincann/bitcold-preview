import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

function makeLocalEcho(term: Terminal, sendLine: (line: string) => void) {
  let buffer = "";
  let cursorPos = 0;

  function redrawFromCursor() {
    const tail = buffer.slice(cursorPos);
    term.write(tail + " ");
    for (let i = 0; i < tail.length + 1; i++) term.write("\b");
  }

  function handleData(data: string) {
    const code = data.charCodeAt(0);

    if (data === "\r") {
      if (buffer.trim() === "") return;
      term.write("\r");
      sendLine(buffer + "\n");
      buffer = "";
      cursorPos = 0;
    } else if (data === "\x7f" || data === "\b") {
      if (cursorPos > 0) {
        buffer = buffer.slice(0, cursorPos - 1) + buffer.slice(cursorPos);
        cursorPos--;
        term.write("\b");
        redrawFromCursor();
      }
    } else if (data === "\x1b[3~") {
      if (cursorPos < buffer.length) {
        buffer = buffer.slice(0, cursorPos) + buffer.slice(cursorPos + 1);
        redrawFromCursor();
      }
    } else if (data === "\x1b[C") {
      if (cursorPos < buffer.length) {
        cursorPos++;
        term.write(data);
      }
    } else if (data === "\x1b[D") {
      if (cursorPos > 0) {
        cursorPos--;
        term.write(data);
      }
    } else if (data === "\x1b[A" || data === "\x1b[B") {
      // up/down arrows — no history, ignore
    } else if (data === "\x1b[H" || data === "\x1b[1~") {
      const steps = cursorPos;
      cursorPos = 0;
      for (let i = 0; i < steps; i++) term.write("\x1b[D");
    } else if (data === "\x1b[F" || data === "\x1b[4~") {
      const steps = buffer.length - cursorPos;
      cursorPos = buffer.length;
      for (let i = 0; i < steps; i++) term.write("\x1b[C");
    } else if (data === "\x03") {
      term.write("^C\r\n");
      sendLine("\x03");
      buffer = "";
      cursorPos = 0;
    } else if (data === "\x04") {
      sendLine("\x04");
    } else if (data === "\x0c") {
      term.clear();
    } else if (code >= 32 || code === 9) {
      const head = buffer.slice(0, cursorPos);
      const tail = buffer.slice(cursorPos);
      buffer = head + data + tail;
      cursorPos += data.length;
      term.write(data + tail);
      for (let i = 0; i < tail.length; i++) term.write("\b");
    }
  }

  return { handleData };
}

export default function TerminalPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const connect = useCallback((term: Terminal, fitAddon: FitAddon) => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/terminal`);
    wsRef.current = ws;

    const echo = makeLocalEcho(term, (line) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data: line }));
      }
    });

    ws.onopen = () => {
      term.clear();
      fitAddon.fit();
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "output") {
          term.write(msg.data);
        } else if (msg.type === "exit") {
          term.writeln("\r\n\x1b[33m[Session ended. Refresh to start a new session.]\x1b[0m");
        }
      } catch {
        term.write(event.data);
      }
    };

    ws.onclose = () => {
      term.writeln("\r\n\x1b[31m[Connection closed]\x1b[0m");
    };

    ws.onerror = () => {
      term.writeln("\r\n\x1b[31m[Connection error]\x1b[0m");
    };

    term.onData(echo.handleData);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Code", "Fira Code", Menlo, Monaco, "Courier New", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      theme: {
        background: "#1a1a1a",
        foreground: "#e6edf3",
        cursor: "#f0883e",
        selectionBackground: "#264f78",
        black: "#484f58",
        red: "#ff7b72",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#39c5cf",
        white: "#b1bac4",
        brightBlack: "#6e7681",
        brightRed: "#ffa198",
        brightGreen: "#56d364",
        brightYellow: "#e3b341",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#56d4dd",
        brightWhite: "#f0f6fc",
      },
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    term.writeln("\x1b[36m╔══════════════════════════════════════════════════╗\x1b[0m");
    term.writeln("\x1b[36m║          bitcold Web Terminal                    ║\x1b[0m");
    term.writeln("\x1b[36m║  Bitcoin Cold Wallet CLI - Type bitcold --help   ║\x1b[0m");
    term.writeln("\x1b[36m╚══════════════════════════════════════════════════╝\x1b[0m");
    term.writeln("\x1b[90mConnecting...\x1b[0m\r\n");

    connect(term, fitAddon);

    const handleResize = () => {
      fitAddon.fit();
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })
        );
      }
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      wsRef.current?.close();
      term.dispose();
    };
  }, [connect]);

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        background: "#1a1a1a",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        ref={containerRef}
        style={{
          flex: 1,
          padding: "8px",
          overflow: "hidden",
        }}
      />
    </div>
  );
}
