import type { MdnsService } from "@devioarts/capacitor-mdns";

import { serviceKey } from "../serviceKey.ts";

export function ServiceList({ services, empty }: { services: MdnsService[]; empty: string }) {
  if (!services.length) return <p className="text-sm text-slate-600">{empty}</p>;
  return (
    <ul className="divide-y divide-slate-200" aria-label="Services">
      {services.map(service => (
        <li key={serviceKey(service)} className="py-3 space-y-1 min-w-0">
          <p className="font-medium break-words">{service.name}</p>
          <p className="text-sm text-slate-600 break-all">{service.type} · {service.domain} · port {service.port}</p>
          <p className="text-sm font-mono break-all">{service.hosts.join(", ") || "Waiting for an IP address"}</p>
          {service.hostname ? <p className="text-sm text-slate-600 break-all">{service.hostname}</p> : null}
          {service.txt && Object.keys(service.txt).length ? (
            <dl className="text-sm grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {Object.entries(service.txt).map(([key, value]) => (
                <div key={key} className="contents"><dt className="break-all font-medium">{key}</dt><dd className="break-all min-w-0">{value || "(empty)"}</dd></div>
              ))}
            </dl>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
