import React, { useState } from "react";
import { mDNS } from "@devioarts/capacitor-mdns";
import { useLogger } from "../components/LoggerContext.ts";
import { Button } from "../components/Button.tsx";
import { Input, Label, TextArea } from "../components/Input.tsx";

export const PageBroadcast: React.FC = () => {
  const log = useLogger();
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [publishedName, setPublishedName] = useState("");
  const [port, setPort] = useState(9100);
  const [type, setType] = useState("_http._tcp.");
  const [serviceId, setServiceId] = useState(() => "MyApp-" + Math.random().toString().substring(2, 5));
  const [txt, setTxt] = useState('{"role":"playground"}');
  const startBroadcast = async () => {
    setBusy(true);
    setError("");
    try {
      const values: unknown = JSON.parse(txt || "{}");
      if (!values || typeof values !== "object" || Array.isArray(values) || Object.values(values).some(value => typeof value !== "string")) throw new Error("TXT must be a JSON object with string values.");
      const result = await mDNS.startBroadcast({ type, name: serviceId, port, txt: values as Record<string, string> });
      setActive(result.publishing);
      if (result.error) { setError(result.errorMessage ?? "Could not publish service"); log.error("broadcast", "Broadcast failed", result); }
      else { setPublishedName(result.name); log.info("broadcast", "Broadcast started", result); }
    } catch (cause) { setError(String(cause)); log.error("broadcast", "Broadcast failed", cause); }
    finally { setBusy(false); }
  };
  const stopBroadcast = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await mDNS.stopBroadcast();
      setActive(result.publishing);
      if (result.error) { setError(result.errorMessage ?? "Could not stop publishing"); log.error("broadcast", "Broadcast stop failed", result); }
      else log.info("broadcast", "Broadcast stopped", result);
    } catch (cause) { setError(String(cause)); log.error("broadcast", "Broadcast stop failed", cause); }
    finally { setBusy(false); }
  };
  return (
    <section className="border border-slate-200 rounded-lg p-4 space-y-3">
      <h3 className="font-semibold">Broadcasting</h3>
      <p role="status" className="text-sm break-words">{busy ? "Updating broadcast…" : active ? `Publishing: ${publishedName}` : "Broadcast stopped"}</p>
      <div className="grid sm:grid-cols-2 gap-3">
        <Label label="Name"><Input value={serviceId} onChange={e => setServiceId(e.target.value)} /></Label>
        <Label label="Type"><Input value={type} onChange={e => setType(e.target.value)} /></Label>
        <Label label="Port"><Input type="number" min={1} max={65535} step={1} value={port} onChange={e => setPort(+e.target.value)} /></Label>
        <Label label="TXT records (JSON)"><TextArea rows={3} value={txt} onChange={e => setTxt(e.target.value)} spellCheck={false} /></Label>
      </div>
      {error ? <p role="alert" className="text-sm text-rose-700 break-words">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="green" onClick={startBroadcast} disabled={busy}>{active ? "Update broadcast" : "Start broadcasting"}</Button>
        <Button type="red" onClick={stopBroadcast} disabled={busy || !active}>Stop broadcasting</Button>
      </div>
      <p className="text-sm text-slate-600">Domain: local. Keep this service running while testing discovery from another device on the same network.</p>
    </section>
  );
};
