import { createContext, useContext } from "react";

export type LoggerSink = "panel" | "console" | "both";

export interface LogEntry {
  ts: number;
  level: "info" | "warn" | "error";
  scope: string;
  msg: string;
  data?: unknown;
}

export interface LoggerCtx {
  sink: LoggerSink;
  setSink: (s: LoggerSink) => void;
  logs: LogEntry[];
  clear: () => void;
  info: (scope: string, msg: string, data?: unknown) => void;
  warn: (scope: string, msg: string, data?: unknown) => void;
  error: (scope: string, msg: string, data?: unknown) => void;
}

export const Ctx = createContext<LoggerCtx | null>(null);

export function useLogger(): LoggerCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("LoggerProvider missing");
  return v;
}
