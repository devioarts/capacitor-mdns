import React from "react";
import { LoggerProvider, LogViewer, LoggerSinkSwitch } from "./components/Logger.tsx";
import type { LoggerPosition, LoggerSize } from "./components/Logger.tsx";
import { Playground } from "./Playground.tsx";

export default function App() {
  const [logOpen, setLogOpen] = React.useState(false);
  const [logPosition, setLogPosition] = React.useState<LoggerPosition>("bottom");
  const [logSize, setLogSize] = React.useState<LoggerSize>(1);

  const loggerProps = {
    open: logOpen,
    onToggle: () => setLogOpen((v) => !v),
    position: logPosition,
    onTogglePosition: () => setLogPosition((p) => (p === "bottom" ? "right" : "bottom")),
    size: logSize,
    onSizeChange: setLogSize,
  };

  return (
    <LoggerProvider>
      <div className="h-screen flex flex-col bg-white text-slate-900">
        <Header title="mDNS — Playground">
          <LoggerSinkSwitch />
        </Header>
        <div className={`flex-1 flex overflow-hidden ${logPosition === "bottom" ? "flex-col" : "flex-row"}`}>
          <main className="flex-1 flex flex-col overflow-hidden">
            <Playground />
          </main>
          <LogViewer {...loggerProps} />
        </div>
      </div>
    </LoggerProvider>
  );
}

type HeaderProps = React.PropsWithChildren<{
  title?: string;
}>;

function Header({ title = "Playground", children }: HeaderProps) {
  return (
    <header className="border-b border-slate-200 bg-slate-50 flex-shrink-0">
      <div className="px-4 py-3 flex items-center justify-between gap-4">
        <h1 className="text-xl font-bold truncate">{title}</h1>
        {children && <div className="flex items-center gap-3">{children}</div>}
      </div>
    </header>
  );
}
