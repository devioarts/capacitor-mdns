import React, { useState } from "react";
import { mDNS } from "@devioarts/capacitor-mdns";
import { useLogger } from "../components/Logger.tsx";
import { Button } from "../components/Button.tsx";
import { Input, Label } from "../components/Input.tsx";

export const PageDiscovery: React.FC = () => {
  const log = useLogger();
  const [discType, setDiscType] = useState<string>("_http._tcp.");
  const [discName, setDiscName] = useState<string>("");
  const [discTimeout, setDiscTimeout] = useState<number>(3000);
  const [discUseNW, setDiscUseNW] = useState<boolean>(true);

  const discover = async () => {
    log.info("server", "Discovering");
    try {
      const res = await mDNS.discover({
        type: discType,
        name: discName.length > 0 ? discName : undefined,
        timeout: discTimeout,
        useNW: discUseNW,
      });
      log.info("server", "Discovering", res);
    } catch (e) {
      log.error("server", "Discovering failed", e);
    }
  };

  return (
    <div className="space-y-6">
      <section className="border border-slate-200 rounded-lg p-4 space-y-3">
        <h3 className="font-semibold">Discovery</h3>
        <div className="grid sm:grid-cols-3 gap-3">
          <Label label="Name"><Input type="text" value={discName} onChange={e => setDiscName(e.target.value)} /></Label>
          <Label label="Timeout"><Input type="text" value={discTimeout} onChange={e => setDiscTimeout(+e.target.value)} /></Label>
          <Label label="Type"><Input type="text" value={discType} onChange={e => setDiscType(e.target.value)} /></Label>
          <label className="text-sm flex items-center gap-2">
            <input type="checkbox" checked={discUseNW} onChange={e => setDiscUseNW(e.target.checked)} />
            Use NW (iOS)
          </label>
        </div>
        <hr />
        <div className="flex flex-wrap gap-2">
          <Button type="neutral" onClick={discover}>Discover</Button>
        </div>
      </section>
    </div>
  );
};
