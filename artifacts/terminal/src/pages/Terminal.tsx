import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

function makeLocalEcho(
  term: Terminal,
  sendLine: (line: string) => void,
  isAtShellPrompt: () => boolean
) {
  let buffer = "";
  let cursorPos = 0;

  // Command history
  const history: string[] = [];
  let historyIndex = -1;
  let savedBuffer = ""; // buffer saved when browsing history

  function redrawFromCursor() {
    const tail = buffer.slice(cursorPos);
    term.write(tail + " ");
    for (let i = 0; i < tail.length + 1; i++) term.write("\b");
  }

  // Replace entire buffer contents and move cursor to end.
  function replaceBuffer(newBuf: string) {
    // Move to start of current buffer
    for (let i = 0; i < cursorPos; i++) term.write("\b");
    // Overwrite with new content, pad to erase old trailing chars
    const pad = newBuf.length < buffer.length
      ? " ".repeat(buffer.length - newBuf.length)
      : "";
    term.write(newBuf + pad);
    // Move cursor back past the padding
    for (let i = 0; i < pad.length; i++) term.write("\b");
    buffer = newBuf;
    cursorPos = newBuf.length;
  }

  // Move cursor to an absolute position within the buffer.
  function moveCursorTo(newPos: number) {
    newPos = Math.max(0, Math.min(buffer.length, newPos));
    const diff = newPos - cursorPos;
    if (diff > 0) {
      for (let i = 0; i < diff; i++) term.write("\x1b[C");
    } else if (diff < 0) {
      for (let i = 0; i < -diff; i++) term.write("\x1b[D");
    }
    cursorPos = newPos;
  }

  // Find word boundary scanning left from pos.
  function wordLeft(pos: number): number {
    let i = pos;
    while (i > 0 && buffer[i - 1] === " ") i--;
    while (i > 0 && buffer[i - 1] !== " ") i--;
    return i;
  }

  // Find word boundary scanning right from pos.
  function wordRight(pos: number): number {
    let i = pos;
    while (i < buffer.length && buffer[i] === " ") i++;
    while (i < buffer.length && buffer[i] !== " ") i++;
    return i;
  }

  function submitBuffer(forceNewline = false) {
    if (buffer.trim() === "") return;
    term.write(forceNewline || isAtShellPrompt() ? "\r\n" : "\r");
    // Save non-duplicate entry to history
    if (history[0] !== buffer) history.unshift(buffer);
    historyIndex = -1;
    savedBuffer = "";
    sendLine(buffer + "\n");
    buffer = "";
    cursorPos = 0;
  }

  function handleData(data: string) {
    const code = data.charCodeAt(0);

    // Paste: multiple characters arriving at once (not an escape sequence).
    if (data.length > 1 && !data.startsWith("\x1b")) {
      const rawLines = data.split(/\r\n|\r|\n/);
      for (let i = 0; i < rawLines.length; i++) {
        const seg = rawLines[i];
        const isLast = i === rawLines.length - 1;

        if (seg.length > 0) {
          term.write(seg);
          const stripped = seg.trimEnd();
          if (!isLast && stripped.endsWith("\\")) {
            buffer += stripped.slice(0, -1) + " ";
          } else {
            buffer += seg;
          }
          cursorPos = buffer.length;
        }

        if (!isLast) {
          term.write("\r\n");
          if (!seg.trimEnd().endsWith("\\") && buffer.trim()) {
            submitBuffer(/* forceNewline */ true);
          }
        }
      }

      if (rawLines[rawLines.length - 1] === "" && buffer.trim()) {
        submitBuffer(/* forceNewline */ true);
      }
      return;
    }

    if (data === "\r") {
      if (buffer.trim() === "") return;
      submitBuffer();

    // ── Backspace ──────────────────────────────────────────────────────────
    } else if (data === "\x7f" || data === "\b") {
      if (cursorPos > 0) {
        buffer = buffer.slice(0, cursorPos - 1) + buffer.slice(cursorPos);
        cursorPos--;
        term.write("\b");
        redrawFromCursor();
      }

    // ── Delete ─────────────────────────────────────────────────────────────
    } else if (data === "\x1b[3~") {
      if (cursorPos < buffer.length) {
        buffer = buffer.slice(0, cursorPos) + buffer.slice(cursorPos + 1);
        redrawFromCursor();
      }

    // ── Arrow right ────────────────────────────────────────────────────────
    } else if (data === "\x1b[C") {
      if (cursorPos < buffer.length) { cursorPos++; term.write(data); }

    // ── Arrow left ─────────────────────────────────────────────────────────
    } else if (data === "\x1b[D") {
      if (cursorPos > 0) { cursorPos--; term.write(data); }

    // ── Word right: Ctrl+Right / Alt+Right (ESC f / ESC [1;5C / ESC [1;3C) ─
    } else if (
      data === "\x1b[1;5C" || data === "\x1b[1;3C" ||
      data === "\x1bf"     || data === "\x1b\x1b[C"
    ) {
      moveCursorTo(wordRight(cursorPos));

    // ── Word left: Ctrl+Left / Alt+Left (ESC b / ESC [1;5D / ESC [1;3D) ──
    } else if (
      data === "\x1b[1;5D" || data === "\x1b[1;3D" ||
      data === "\x1bb"     || data === "\x1b\x1b[D"
    ) {
      moveCursorTo(wordLeft(cursorPos));

    // ── History: Up ────────────────────────────────────────────────────────
    } else if (data === "\x1b[A") {
      if (history.length === 0) return;
      if (historyIndex === -1) savedBuffer = buffer;
      if (historyIndex < history.length - 1) {
        historyIndex++;
        replaceBuffer(history[historyIndex]);
      }

    // ── History: Down ──────────────────────────────────────────────────────
    } else if (data === "\x1b[B") {
      if (historyIndex === -1) return;
      historyIndex--;
      replaceBuffer(historyIndex === -1 ? savedBuffer : history[historyIndex]);

    // ── Home / Ctrl+A / Cmd+Left ───────────────────────────────────────────
    } else if (
      data === "\x1b[H"    || data === "\x1b[1~" ||
      data === "\x01"      || data === "\x1b[1;9D"
    ) {
      moveCursorTo(0);

    // ── End / Ctrl+E / Cmd+Right ───────────────────────────────────────────
    } else if (
      data === "\x1b[F"    || data === "\x1b[4~" ||
      data === "\x05"      || data === "\x1b[1;9C"
    ) {
      moveCursorTo(buffer.length);

    // ── Ctrl+K: kill to end of line ────────────────────────────────────────
    } else if (data === "\x0b") {
      const erased = buffer.length - cursorPos;
      buffer = buffer.slice(0, cursorPos);
      for (let i = 0; i < erased; i++) term.write(" ");
      for (let i = 0; i < erased; i++) term.write("\b");

    // ── Ctrl+U: kill to start of line ─────────────────────────────────────
    } else if (data === "\x15") {
      const prefixLen = cursorPos;
      const tail = buffer.slice(cursorPos);
      // Move cursor to start of input
      for (let i = 0; i < prefixLen; i++) term.write("\b");
      // Write tail + spaces to erase old prefix, then move cursor all the way back
      term.write(tail + " ".repeat(prefixLen));
      for (let i = 0; i < tail.length + prefixLen; i++) term.write("\b");
      buffer = tail;
      cursorPos = 0;

    // ── Ctrl+W: delete word left ───────────────────────────────────────────
    } else if (data === "\x17") {
      const target = wordLeft(cursorPos);
      const deleted = cursorPos - target;
      const tail = buffer.slice(cursorPos);
      buffer = buffer.slice(0, target) + tail;
      for (let i = 0; i < deleted; i++) term.write("\b");
      cursorPos = target;
      term.write(tail + " ".repeat(deleted));
      for (let i = 0; i < tail.length + deleted; i++) term.write("\b");

    // ── Alt+Backspace: delete word left (same as Ctrl+W) ───────────────────
    } else if (data === "\x1b\x7f") {
      const target = wordLeft(cursorPos);
      const deleted = cursorPos - target;
      const tail = buffer.slice(cursorPos);
      buffer = buffer.slice(0, target) + tail;
      for (let i = 0; i < deleted; i++) term.write("\b");
      cursorPos = target;
      term.write(tail + " ".repeat(deleted));
      for (let i = 0; i < tail.length + deleted; i++) term.write("\b");

    // ── Ctrl+C ─────────────────────────────────────────────────────────────
    } else if (data === "\x03") {
      term.write("^C\r\n");
      sendLine("\x03");
      buffer = "";
      cursorPos = 0;
      historyIndex = -1;
      savedBuffer = "";

    // ── Ctrl+D ─────────────────────────────────────────────────────────────
    } else if (data === "\x04") {
      sendLine("\x04");

    // ── Ctrl+L: clear screen ───────────────────────────────────────────────
    } else if (data === "\x0c") {
      term.clear();

    // ── Printable characters ───────────────────────────────────────────────
    } else if (code >= 32 || code === 9) {
      const head = buffer.slice(0, cursorPos);
      const tail = buffer.slice(cursorPos);
      buffer = head + data + tail;
      cursorPos += data.length;
      term.write(data + tail);
      for (let i = 0; i < tail.length; i++) term.write("\b");
    }
  }

  // Erase the entire input line (used by Cmd+Backspace).
  function killLine() {
    for (let i = 0; i < cursorPos; i++) term.write("\b");
    term.write(" ".repeat(buffer.length));
    for (let i = 0; i < buffer.length; i++) term.write("\b");
    buffer = "";
    cursorPos = 0;
  }

  return { handleData, killLine };
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

    // Track whether the shell prompt (❯) is currently visible, meaning the
    // user is at the shell prompt rather than inside an interactive program.
    let atShellPrompt = true;

    const echo = makeLocalEcho(
      term,
      (line) => {
        if (ws.readyState === WebSocket.OPEN) {
          // Submitting from the shell prompt enters the program; submitting
          // from inside a program stays in the program.
          atShellPrompt = false;
          ws.send(JSON.stringify({ type: "input", data: line }));
        }
      },
      () => atShellPrompt
    );

    ws.onopen = () => {
      term.clear();
      fitAddon.fit();
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "output") {
          // The shell prompt contains ❯ — when we see it we're back at the prompt.
          if (msg.data.includes("❯")) atShellPrompt = true;
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

    // Cmd+Backspace: erase entire input line (browser key event, not a VT sequence)
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.metaKey && e.key === "Backspace") {
        echo.killLine();
        return false;
      }
      return true;
    });
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Code", "Fira Code", Menlo, Monaco, "Courier New", monospace',
      fontSize: 14,
      lineHeight: 1.0,
      letterSpacing: 0,
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
