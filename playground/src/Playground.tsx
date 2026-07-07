import React, { useState, useRef, useEffect } from "react";
import { mDNS } from "@devioarts/capacitor-mdns";
import { TabButton } from "./components/TabButton.tsx";
import { tabs } from "./tabs.tsx";

export const Playground: React.FC = () => {
  const [active, setActive] = useState<string>("broadcast");
  const activeTab = tabs.find((tab) => tab.id === active);

  const barRef = useRef<HTMLDivElement>(null);
  const [fadeLeft, setFadeLeft] = useState(false);
  const [fadeRight, setFadeRight] = useState(false);
  const [platform, setPlatform] = useState<string>("...");

  const checkFades = () => {
    const el = barRef.current;
    if (!el) return;
    setFadeLeft(el.scrollLeft > 0);
    setFadeRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  };

  useEffect(() => {
    checkFades();
    const el = barRef.current;
    if (!el) return;
    el.addEventListener("scroll", checkFades);
    const ro = new ResizeObserver(checkFades);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", checkFades); ro.disconnect(); };
  }, []);

  useEffect(() => {
    mDNS.getPluginPlatform()
      .then((result) => setPlatform(result.platform))
      .catch(() => setPlatform("unknown"));
  }, []);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="relative flex-shrink-0 bg-slate-50 border-b border-slate-200">
        <div className="flex items-center justify-between gap-3 pr-4">
          <div
            ref={barRef}
            className="flex min-w-0 flex-1 items-center overflow-x-auto [&::-webkit-scrollbar]:hidden"
            style={{ scrollbarWidth: "none" }}
          >
            {tabs.map((tab, index) => (
              <TabButton key={index} tabId={tab.id} active={active} onClick={() => setActive(tab.id)}>
                {tab.label}
              </TabButton>
            ))}
          </div>
          <div className="shrink-0 rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700">
            {platform}
          </div>
        </div>
        {fadeLeft && (
          <div className="absolute left-0 top-0 bottom-0 w-10 bg-gradient-to-r from-slate-50 to-transparent pointer-events-none" />
        )}
        {fadeRight && (
          <div className="absolute right-0 top-0 bottom-0 w-10 bg-gradient-to-l from-slate-50 to-transparent pointer-events-none" />
        )}
      </div>
      <div className="flex-1 overflow-auto px-4 py-6">
        {activeTab?.page}
      </div>
    </div>
  );
};
