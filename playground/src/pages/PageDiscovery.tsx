import React, { useEffect, useRef, useState } from "react";
import type { PluginListenerHandle } from "@capacitor/core";
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
  const [watchTypes, setWatchTypes] = useState("_http._tcp., _ipp._tcp.");
  const [watching, setWatching] = useState(false);
  const [watchBusy, setWatchBusy] = useState(false);
  const [listenersReady, setListenersReady] = useState(false);
  const logger = useRef(log);
  useEffect(() => { logger.current = log; }, [log]);

  useEffect(() => {
    let disposed = false;
    const subscriptions: PluginListenerHandle[] = [];
    void Promise.allSettled([
      mDNS.addListener("serviceFound", event => logger.current.info("watch", "Service found", event.service)),
      mDNS.addListener("serviceLost", event => logger.current.info("watch", "Service lost", event.service)),
      mDNS.addListener("watchError", event => {
        logger.current.error("watch", "Watching failed", event);
        if (!disposed) setWatching(event.watching);
      }),
    ]).then(results => {
      for (const result of results) {
        if (result.status === "fulfilled") {
          if (disposed) void result.value.remove();
          else subscriptions.push(result.value);
        } else logger.current.error("watch", "Listener registration failed", result.reason);
      }
      if (!disposed) setListenersReady(results.every(result => result.status === "fulfilled"));
    });
    return () => {
      disposed = true;
      void mDNS.stopWatching().catch(error => logger.current.error("watch", "Stop failed", error));
      for (const subscription of subscriptions) void subscription.remove();
    };
  }, []);

  const startWatch = async () => {
    setWatchBusy(true);
    try {
      const result = await mDNS.watchServices({ types: watchTypes.split(",").map(type => type.trim()).filter(Boolean) });
      if (result.error) log.error("watch", "Start failed", result);
      else { setWatching(true); log.info("watch", "Watching started", result); }
    } catch (error) { log.error("watch", "Start failed", error); }
    finally { setWatchBusy(false); }
  };

  const stopWatch = async () => {
    setWatchBusy(true);
    try {
      const result = await mDNS.stopWatching();
      setWatching(result.watching);
      if (result.error) log.error("watch", "Stop failed", result);
      else log.info("watch", "Watching stopped", result);
    } catch (error) { log.error("watch", "Stop failed", error); }
    finally { setWatchBusy(false); }
  };

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
      <section className="border border-slate-200 rounded-lg p-4 space-y-3">
        <h3 className="font-semibold">Continuous discovery</h3>
        <Label label="Service types (comma separated)">
          <Input type="text" value={watchTypes} onChange={event => setWatchTypes(event.target.value)} />
        </Label>
        <p role="status">{watching ? "Watching for service changes" : "Watching stopped"}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="neutral" disabled={watchBusy || !listenersReady} onClick={startWatch}>Start / replace watch</Button>
          <Button type="neutral" disabled={watchBusy} onClick={stopWatch}>Stop watching</Button>
        </div>
      </section>
    </div>
  );
};
