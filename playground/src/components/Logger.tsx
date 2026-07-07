import React, { useEffect } from "react";

export type LoggerSink = "panel" | "console" | "both";

export interface LogEntry {
  ts: number;
  level: "info" | "warn" | "error";
  scope: string;
  msg: string;
  data?: unknown;
}

interface LoggerCtx {
  sink: LoggerSink;
  setSink: (s: LoggerSink) => void;
  logs: LogEntry[];
  clear: () => void;
  info: (scope: string, msg: string, data?: unknown) => void;
  warn: (scope: string, msg: string, data?: unknown) => void;
  error: (scope: string, msg: string, data?: unknown) => void;
}

const Ctx = React.createContext<LoggerCtx | null>(null);

export const LoggerProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [sink, setSink] = React.useState<LoggerSink>("console");
  const [logs, setLogs] = React.useState<LogEntry[]>([]);

  const push = React.useCallback(
    (level: LogEntry["level"], scope: string, msg: string, data?: unknown) => {
      const entry: LogEntry = { ts: Date.now(), level, scope, msg, data };
      if (sink === "panel" || sink === "both") {
        setLogs((prev) => {
          const trimmed = prev.length > 500 ? prev.slice(prev.length - 500) : prev;
          return [...trimmed, entry];
        });
      }
      if (sink === "console" || sink === "both") {
        const line = `[${new Date(entry.ts).toLocaleTimeString()}][${scope}] ${level.toUpperCase()}: ${msg}`;
        if (level === "info") console.log(line, data ?? "");
        else if (level === "warn") console.warn(line, data ?? "");
        else console.error(line, data ?? "");
      }
    },
    [sink],
  );

  const ctx: LoggerCtx = {
    sink, setSink, logs,
    clear: () => setLogs([]),
    info:  (scope, msg, data) => push("info",  scope, msg, data),
    warn:  (scope, msg, data) => push("warn",  scope, msg, data),
    error: (scope, msg, data) => push("error", scope, msg, data),
  };

  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
};

export function useLogger(): LoggerCtx {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("LoggerProvider missing");
  return v;
}

export const LoggerSinkSwitch: React.FC = () => {
  const { sink, setSink } = useLogger();
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-slate-400 text-xs">sink:</span>
      <select
        className="bg-white border border-slate-300 rounded px-2 py-1 text-xs"
        value={sink}
        onChange={(e) => setSink(e.target.value as LoggerSink)}
      >
        <option value="panel">panel</option>
        <option value="console">console</option>
        <option value="both">both</option>
      </select>
    </label>
  );
};

export type LoggerPosition = "bottom" | "right";
export type LoggerSize = 1 | 2 | 3;

export type LogViewerProps = {
  open: boolean;
  onToggle: () => void;
  position: LoggerPosition;
  onTogglePosition: () => void;
  size: LoggerSize;
  onSizeChange: (s: LoggerSize) => void;
};

const BOTTOM_HEIGHTS: Record<LoggerSize, string> = { 1: "h-50", 2: "h-80", 3: "h-120" };
const RIGHT_WIDTHS:   Record<LoggerSize, string> = { 1: "w-80", 2: "w-100", 3: "w-120" };

const ChevronDown = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);
const ChevronUp = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M4 10l4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);
const ChevronRight = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);
const ChevronLeft = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M10 4l-4 4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);
const IconPanelBottom = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
    <line x1="1.5" y1="10" x2="14.5" y2="10" stroke="currentColor" strokeWidth="1.2"/>
    <rect x="1.5" y="10" width="13" height="5" fill="currentColor" opacity="0.3"/>
  </svg>
);
const IconPanelRight = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
    <line x1="10" y1="1.5" x2="10" y2="14.5" stroke="currentColor" strokeWidth="1.2"/>
    <rect x="10" y="1.5" width="5" height="13" fill="currentColor" opacity="0.3"/>
  </svg>
);

const IconSize: React.FC<{ position: LoggerPosition; size: LoggerSize }> = ({ position, size }) => {
  const fills: Record<LoggerSize, number> = { 1: 0.28, 2: 0.45, 3: 0.65 };
  const r = fills[size];
  const W = 14, H = 14;

  if (position === "bottom") {
    const py = H * (1 - r);
    return (
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} fill="none">
        <rect x="0.5" y="0.5" width={W - 1} height={H - 1} rx="1.5" stroke="currentColor" strokeWidth="1"/>
        <line x1="0.5" y1={py} x2={W - 0.5} y2={py} stroke="currentColor" strokeWidth="1"/>
        <rect x="0.5" y={py} width={W - 1} height={H - py} fill="currentColor" opacity="0.35"/>
      </svg>
    );
  }

  const px = W * (1 - r);
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} fill="none">
      <rect x="0.5" y="0.5" width={W - 1} height={H - 1} rx="1.5" stroke="currentColor" strokeWidth="1"/>
      <line x1={px} y1="0.5" x2={px} y2={H - 0.5} stroke="currentColor" strokeWidth="1"/>
      <rect x={px} y="0.5" width={W - px} height={H - 1} fill="currentColor" opacity="0.35"/>
    </svg>
  );
};

const IconBtn: React.FC<React.PropsWithChildren<{ onClick: () => void; title?: string; active?: boolean }>> = ({ onClick, title, active, children }) => (
  <button
    onClick={onClick}
    title={title}
    className={[
      "w-8 h-8 flex items-center justify-center rounded transition-colors flex-shrink-0",
      active
        ? "bg-slate-200 text-slate-800"
        : "text-slate-500 hover:text-slate-700 hover:bg-slate-200",
    ].join(" ")}
  >
    {children}
  </button>
);

const LogEntries: React.FC<{
  logs: LogEntry[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  className?: string;
}> = ({ logs, scrollRef, className }) => (
  <div ref={scrollRef} className={`overflow-auto text-xs p-2 ${className ?? ""}`}>
    {logs.length === 0 ? (
      <div className="text-slate-400 p-1">No logs yet…</div>
    ) : (
      <ul className="space-y-1.5">
        {logs.map((l, i) => (
          <li
            key={i}
            className={[
              l.level === "error" ? "bg-rose-600/10" : l.level === "warn" ? "bg-amber-600/10" : "bg-emerald-700/10",
              "rounded border border-slate-100 p-2",
            ].join(" ")}
          >
            <div className="flex items-center gap-2 text-[11px] text-slate-500">
              <span className="font-mono">{new Date(l.ts).toLocaleTimeString()}</span>
              {l.scope && <span className="rounded bg-slate-100 px-1 py-0.5 font-mono">{l.scope}</span>}
              <span className={["font-semibold", l.level === "error" ? "text-rose-600" : l.level === "warn" ? "text-amber-600" : "text-emerald-700"].join(" ")}>
                {l.level.toUpperCase()}
              </span>
            </div>
            <div className="mt-0.5 text-slate-800">{l.msg}</div>
            {typeof l.data !== "undefined" && (
              <pre className="mt-1 overflow-auto rounded bg-slate-50 p-1.5 text-[10px] leading-snug text-slate-600">
                {formatData(l.data)}
              </pre>
            )}
          </li>
        ))}
      </ul>
    )}
  </div>
);

export const LogViewer: React.FC<LogViewerProps> = ({ open, onToggle, position, onTogglePosition, size, onSizeChange }) => {
  const { logs, clear } = useLogger();
  const scrollRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, open]);

  const sizeButtons = (
    <div className="flex items-center gap-0.5">
      {([1, 2, 3] as LoggerSize[]).map((s) => (
        <IconBtn key={s} onClick={() => onSizeChange(s)} active={size === s} title={`Size ${s}`}>
          <IconSize position={position} size={s} />
        </IconBtn>
      ))}
    </div>
  );

  const clearBtn = (
    <button
      className="text-xs px-2 py-1 rounded bg-slate-800 text-white hover:bg-slate-900 transition-colors"
      onClick={clear}
    >
      Clear
    </button>
  );

  /* ── Bottom ── */
  if (position === "bottom") {
    return (
      <div className="border-t border-slate-200 bg-white flex-shrink-0">
        <div className="px-3 py-1 bg-slate-50 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <IconBtn onClick={onToggle} title={open ? "Collapse" : "Expand"}>
              {open ? <ChevronDown /> : <ChevronUp />}
            </IconBtn>
            <span className="font-medium text-sm">Logger</span>
            {logs.length > 0 && <span className="text-xs text-slate-400 font-mono ml-1">{logs.length}</span>}
          </div>
          <div className="flex items-center gap-1.5">
            {open && sizeButtons}
            <IconBtn onClick={onTogglePosition} title="Move to right panel">
              <IconPanelRight />
            </IconBtn>
            {clearBtn}
          </div>
        </div>
        {open && (
          <LogEntries logs={logs} scrollRef={scrollRef} className={BOTTOM_HEIGHTS[size]} />
        )}
      </div>
    );
  }

  /* ── Right collapsed ── */
  if (!open) {
    return (
      <div className="border-l border-slate-200 bg-slate-50 flex-shrink-0 w-10 flex flex-col items-center py-2 gap-3">
        <IconBtn onClick={onToggle} title="Expand">
          <ChevronLeft />
        </IconBtn>
        <span
          className="text-[10px] text-slate-400 font-mono select-none"
          style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
        >
          Logger
        </span>
      </div>
    );
  }

  /* ── Right open ── */
  return (
    <div className={`border-l border-slate-200 bg-white flex-shrink-0 flex flex-col ${RIGHT_WIDTHS[size]}`}>
      <div className="px-3 py-1 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-2 flex-shrink-0">
        <div className="flex items-center gap-1">
          <IconBtn onClick={onToggle} title="Collapse">
            <ChevronRight />
          </IconBtn>
          <span className="font-medium text-sm">Logger</span>
          {logs.length > 0 && <span className="text-xs text-slate-400 font-mono ml-1">{logs.length}</span>}
        </div>
        <div className="flex items-center gap-1.5">
          {sizeButtons}
          <IconBtn onClick={onTogglePosition} title="Move to bottom panel">
            <IconPanelBottom />
          </IconBtn>
          {clearBtn}
        </div>
      </div>
      <LogEntries logs={logs} scrollRef={scrollRef} className="flex-1" />
    </div>
  );
};

function formatData(d: unknown): string {
  try {
    if (d instanceof Uint8Array) return `Uint8Array[${d.length}]`;
    if (Array.isArray(d)) return JSON.stringify(d, null, 2);
    if (typeof d === "object") return JSON.stringify(d, null, 2);
    return String(d);
  } catch {
    return String(d);
  }
}
