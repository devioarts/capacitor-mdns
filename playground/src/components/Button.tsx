import React from "react";

export const Button: React.FC<React.PropsWithChildren<{
  type?: "primary" | "green" | "red" | "neutral" | "yellow";
  onClick?: () => void;
  disabled?: boolean;
}>> = ({ type = "primary", children, onClick, disabled, ...props }) => {
  const toneClasses = {
    primary: "bg-indigo-600 hover:bg-indigo-700 text-white border border-indigo-700 focus:ring-indigo-400 disabled:opacity-50",
    green:   "bg-emerald-600 hover:bg-emerald-700 text-white border border-emerald-700 focus:ring-emerald-400 disabled:opacity-50",
    red:     "bg-rose-600 hover:bg-rose-700 text-white border border-rose-700 focus:ring-rose-400 disabled:opacity-50",
    neutral: "bg-slate-600 hover:bg-slate-700 text-white border border-slate-700 focus:ring-slate-400 disabled:opacity-50",
    yellow:  "bg-amber-500 hover:bg-amber-600 text-white border border-amber-600 focus:ring-amber-400 disabled:opacity-50",
  }[type];

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      {...props}
      className={[
        "px-3 py-2 rounded-xl text-sm font-medium shadow-sm transition-colors",
        "focus:outline-none focus:ring-2 focus:ring-offset-2",
        toneClasses,
      ].join(" ")}
    >
      {children}
    </button>
  );
};
