import React, { useEffect, useRef, useState } from "react";
import type { PluginListenerHandle } from "@capacitor/core";
import { mDNS } from "@devioarts/capacitor-mdns";
import type { MdnsService } from "@devioarts/capacitor-mdns";
import { useLogger } from "../components/LoggerContext.ts";
import { Button } from "../components/Button.tsx";
import { Input, Label } from "../components/Input.tsx";
import { ServiceList } from "../components/ServiceList.tsx";
import { serviceKey } from "../serviceKey.ts";

export const PageDiscovery: React.FC = () => {
  const log = useLogger();
  const [discType, setDiscType] = useState("_http._tcp.");
  const [discName, setDiscName] = useState("");
  const [discTimeout, setDiscTimeout] = useState(3000);
  const [discUseNW, setDiscUseNW] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<MdnsService[]>([]);
  const [discoverError, setDiscoverError] = useState("");
  const discoverRequest = useRef(0);
  const [watchTypes, setWatchTypes] = useState("_http._tcp., _airplay._tcp., _googlecast._tcp.");
  const [watching, setWatching] = useState(false);
  const [watched, setWatched] = useState<Record<string, MdnsService>>({});
  const [watchBusy, setWatchBusy] = useState(false);
  const [watchError, setWatchError] = useState("");
  const [lastEvent, setLastEvent] = useState("");
  const [listenersReady, setListenersReady] = useState(false);
  const logger = useRef(log);
  useEffect(() => { logger.current = log; }, [log]);

  useEffect(() => {
    let disposed = false;
    const subscriptions: PluginListenerHandle[] = [];
    void Promise.allSettled([
      mDNS.addListener("serviceFound", event => {
        if (disposed) return;
        setWatched(current => ({ ...current, [serviceKey(event.service)]: event.service }));
        setLastEvent(`Found: ${event.service.name}`);
        logger.current.info("watch", "Service found", event.service);
      }),
      mDNS.addListener("serviceLost", event => {
        if (disposed) return;
        setWatched(current => {
          const remaining = { ...current };
          delete remaining[serviceKey(event.service)];
          return remaining;
        });
        setLastEvent(`Lost: ${event.service.name}`);
        logger.current.info("watch", "Service lost", event.service);
      }),
      mDNS.addListener("watchError", event => {
        if (disposed) return;
        logger.current.error("watch", "Watching failed", event);
        setWatching(event.watching);
        setWatchError(event.errorMessage);
        if (!event.watching) setWatched({});
      }),
    ]).then(results => {
      for (const result of results) {
        if (result.status === "fulfilled") {
          if (disposed) void result.value.remove();
          else subscriptions.push(result.value);
        } else if (!disposed) {
          setWatchError("Could not register listeners. Reload the playground to retry.");
          logger.current.error("watch", "Listener registration failed", result.reason);
        }
      }
      if (!disposed) setListenersReady(results.every(result => result.status === "fulfilled"));
    });
    return () => {
      disposed = true;
      discoverRequest.current = -1;
      void mDNS.stopWatching().catch(error => logger.current.error("watch", "Stop failed", error));
      for (const subscription of subscriptions) void subscription.remove().catch(error => logger.current.error("watch", "Listener cleanup failed", error));
    };
  }, []);

  const startWatch = async () => {
    setWatchBusy(true);
    setWatchError("");
    setWatched({});
    setLastEvent("");
    try {
      const result = await mDNS.watchServices({ types: watchTypes.split(",").map(type => type.trim()) });
      if (result.error) { setWatchError(result.errorMessage ?? "Could not start watching"); log.error("watch", "Start failed", result); }
      else { setWatching(true); log.info("watch", "Watching started", result); }
    } catch (error) { setWatchError(String(error)); log.error("watch", "Start failed", error); }
    finally { setWatchBusy(false); }
  };

  const stopWatch = async () => {
    setWatchBusy(true);
    setWatchError("");
    try {
      const result = await mDNS.stopWatching();
      setWatching(result.watching);
      if (!result.watching) setWatched({});
      if (result.error) { setWatchError(result.errorMessage ?? "Could not stop watching"); log.error("watch", "Stop failed", result); }
      else log.info("watch", "Watching stopped", result);
    } catch (error) { setWatchError(String(error)); log.error("watch", "Stop failed", error); }
    finally { setWatchBusy(false); }
  };

  const discover = async () => {
    const request = ++discoverRequest.current;
    setDiscovering(true);
    setDiscoverError("");
    setDiscovered([]);
    log.info("discovery", "Discovering");
    try {
      const result = await mDNS.discover({ type: discType, name: discName || undefined, timeout: discTimeout, useNW: discUseNW });
      if (result.error) log.error("discovery", "Discovery failed", result);
      else log.info("discovery", "Discovery complete", result);
      if (request !== discoverRequest.current) return;
      setDiscovered(result.services);
      setDiscoverError(result.errorMessage ?? "");
    } catch (error) {
      log.error("discovery", "Discovery failed", error);
      if (request === discoverRequest.current) setDiscoverError(String(error));
    } finally { if (request === discoverRequest.current) setDiscovering(false); }
  };

  return (
    <div className="space-y-6">
      <section className="border border-slate-200 rounded-lg p-4 space-y-3" aria-labelledby="discovery-heading">
        <h3 id="discovery-heading" className="font-semibold">Discovery</h3>
        <div className="grid sm:grid-cols-3 gap-3">
          <Label label="Name filter (optional)"><Input value={discName} onChange={e => setDiscName(e.target.value)} /></Label>
          <Label label="Timeout (ms)"><Input type="number" min={0} step={1} value={discTimeout} onChange={e => setDiscTimeout(+e.target.value)} /></Label>
          <Label label="Type"><Input value={discType} onChange={e => setDiscType(e.target.value)} /></Label>
          <label className="text-sm flex items-center gap-2"><input type="checkbox" checked={discUseNW} onChange={e => setDiscUseNW(e.target.checked)} />Use NWBrowser (iOS)</label>
        </div>
        <Button type="neutral" onClick={discover}>{discovering ? "Replace search" : "Discover"}</Button>
        <p role="status" className="text-sm">{discovering ? "Searching… A new search replaces this one." : `${discovered.length} services found`}</p>
        {discoverError ? <p role="alert" className="text-sm text-rose-700 break-words">{discoverError}</p> : null}
        <ServiceList services={discovered} empty={discovering ? "Waiting for results…" : "Run a search to see resolved services."} />
      </section>
      <section className="border border-slate-200 rounded-lg p-4 space-y-3" aria-labelledby="watch-heading">
        <h3 id="watch-heading" className="font-semibold">Continuous discovery</h3>
        <p className="text-sm text-slate-600">Watch several types at once. Services appear when found and disappear when lost. Thanks to Idrimi for the original feature.</p>
        <Label label="Service types (comma separated)"><Input value={watchTypes} disabled={watching || watchBusy} onChange={event => setWatchTypes(event.target.value)} /></Label>
        <p role="status" className="text-sm">{watchBusy ? "Updating watch…" : watching ? `Watching · ${Object.keys(watched).length} services available` : "Watching stopped"}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="green" disabled={watchBusy || watching || !listenersReady} onClick={startWatch}>Start watching</Button>
          <Button type="red" disabled={watchBusy || !watching} onClick={stopWatch}>Stop watching</Button>
        </div>
        {watchError ? <p role="alert" className="text-sm text-rose-700 break-words">{watchError}</p> : null}
        {lastEvent ? <p className="text-sm break-words" aria-live="polite">{lastEvent}</p> : null}
        <ServiceList services={Object.values(watched)} empty={watching ? "Waiting for services. Publish a matching type on another device on the same network." : "Start watching to see live services. Stop watching before changing types."} />
        <p className="text-sm text-slate-600">Watching continues during a one-time search. Switching tabs keeps the watch active. Use Stop watching to end it; broadcasting stays independent.</p>
      </section>
    </div>
  );
};
