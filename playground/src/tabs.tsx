import type { ReactNode } from "react";
import { PageBroadcast } from "./pages/PageBroadcast.tsx";
import { PageDiscovery } from "./pages/PageDiscovery.tsx";

export type TabItem = {
  id: string;
  label: string;
  page: ReactNode;
};

export const tabs: TabItem[] = [
  { id: "broadcast", label: "Broadcast", page: <PageBroadcast /> },
  { id: "discovery", label: "Discovery", page: <PageDiscovery /> },
];
