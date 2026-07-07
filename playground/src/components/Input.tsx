import React from "react";

export const Input: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = (props) => (
	<input
		{...props}
		className={`bg-white border border-slate-300 rounded px-2 py-1 text-sm w-full ${props.className ?? ""}`}
	/>
);

export const TextArea: React.FC<React.TextareaHTMLAttributes<HTMLTextAreaElement>> = (props) => (
	<textarea
		{...props}
		className={`bg-white border border-slate-300 rounded px-2 py-1 text-sm w-full ${props.className ?? ""}`}
	/>
);

export const Label: React.FC<React.PropsWithChildren<{ label: string }>> = ({ label, children }) => (
	<label className="text-sm flex flex-col gap-1">
		<span className="text-slate-600">{label}</span>
		{children}
	</label>
);
