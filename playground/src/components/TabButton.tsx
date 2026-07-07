import React from "react";

export const TabButton: React.FC<React.PropsWithChildren<{
  onClick?: () => void;
  active?: string;
  tabId?: string;
}>> = ({ children, onClick, active, tabId }) => (
  <button
    onClick={onClick}
    className={[
      "px-4 py-2 text-sm font-medium whitespace-nowrap",
      "border-b-2 transition-colors",
      active === tabId
        ? "border-indigo-600 text-indigo-700"
        : "border-transparent text-slate-500 hover:text-slate-700",
    ].join(" ")}
  >
    {children}
  </button>
);
