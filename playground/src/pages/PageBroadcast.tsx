import React, { useState } from "react";
import { mDNS } from "@devioarts/capacitor-mdns";
import { useLogger } from "../components/Logger.tsx";
import { Button } from "../components/Button.tsx";
import { Input, Label } from "../components/Input.tsx";

export const PageBroadcast: React.FC = () => {
  const log = useLogger();
  const [active, setActive] = useState<boolean>(false);
  const [port, setPort] = useState<number>(9100);
  const [type, setType] = useState<string>("_http._tcp.");
  const [domain, setDomain] = useState<string>("local.");
  const [serviceId, setServiceId] = useState<string>("MyApp-" + Math.random().toString().substring(2, 5));

  const startBroadcast = async () => {
    log.info("server", "Starting broadcast");
    try {
      const res = await mDNS.startBroadcast({ type, name: serviceId, port });
      log.info("server", "Broadcast started", res);
      setActive(true);
    } catch (e) {
      log.error("server", "Broadcast failed", e);
    }
  };

  const stopBroadcast = async () => {
    log.info("server", "Stopping broadcast");
    try {
      const res = await mDNS.stopBroadcast();
      log.info("server", "Broadcast stopped", res);
      setActive(false);
    } catch (e) {
      log.error("server", "Broadcast failed", e);
    }
  };

  return (
    <div className="space-y-6">
      <section className="border border-slate-200 rounded-lg p-4 space-y-3">
        <h3 className="font-semibold">
          Broadcasting
          <span className="ml-2 text-sm">
            <b className={active ? "text-emerald-700" : "text-rose-700"}>●</b>
          </span>
        </h3>
        <div className="grid sm:grid-cols-2 gap-3">
          <Label label="Name"><Input type="text" value={serviceId} onChange={e => setServiceId(e.target.value)} /></Label>
          <Label label="Domain"><Input type="text" value={domain} onChange={e => setDomain(e.target.value)} /></Label>
          <Label label="Type"><Input type="text" value={type} onChange={e => setType(e.target.value)} /></Label>
          <Label label="Port"><Input type="number" value={port} onChange={e => setPort(+e.target.value)} /></Label>
        </div>
        <hr />
        <div className="flex flex-wrap gap-2">
          <Button type="green" onClick={startBroadcast} disabled={active}>Start broadcasting</Button>
          <Button type="red" onClick={stopBroadcast} disabled={!active}>Stop broadcasting</Button>
        </div>
      </section>
    </div>
  );
};
