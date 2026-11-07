import type { MdnsService } from "@devioarts/capacitor-mdns";

export const serviceKey = (service: MdnsService) => `${service.name}|${service.type}|${service.domain}`;
