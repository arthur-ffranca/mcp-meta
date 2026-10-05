import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
blocked.addAddress("::1", "ipv6");
blocked.addAddress("::", "ipv6");
blocked.addSubnet("fc00::", 7, "ipv6");
blocked.addSubnet("fe80::", 10, "ipv6");
blocked.addSubnet("::ffff:0:0", 96, "ipv6");

/**
 * Guards server-side fetches of caller-supplied URLs: HTTPS only, and never to loopback,
 * link-local or private addresses (the server usually sits inside a private Docker network).
 */
export async function assertPublicHttpsUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("Only https:// URLs can be fetched.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  for (const a of addresses) {
    if (blocked.check(a.address, a.family === 6 ? "ipv6" : "ipv4")) {
      throw new Error(`Refusing to fetch ${url.hostname}: it resolves to a private or local address.`);
    }
  }
  return url;
}
