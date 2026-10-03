/**
 * Where the server listens (HOST) and which clients it answers (ALLOWED_IPS).
 *
 * HOST defaults to 127.0.0.1, so only this computer can connect. 0.0.0.0, ::
 * or one of this computer's own addresses opens the tool to the network.
 * ALLOWED_IPS then limits it to the listed clients: single addresses and
 * CIDR subnets, IPv4 and IPv6, comma-separated. This computer (loopback) is
 * always allowed. A client is judged by its connection's own address, never
 * by X-Forwarded-For, which any client can set.
 */

import net from "node:net";
import os from "node:os";

export const DEFAULT_HOST = "127.0.0.1";

interface Address {
  version: 4 | 6;
  value: bigint;
}

interface Range extends Address {
  prefix: number;
}

export interface IpAllowList {
  /** The entries as written, for the startup log. */
  entries: string[];
  /** True for a loopback address or one inside an entry. */
  allows(address: string): boolean;
}

export interface NetworkSettings {
  host: string;
  /** False while the server listens on a loopback address only. */
  beyondLoopback: boolean;
  /** Null when ALLOWED_IPS is not set: every client that can connect is answered. */
  allowList: IpAllowList | null;
}

const BITS = { 4: 32, 6: 128 } as const;

function v4Value(text: string): bigint {
  return text.split(".").reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
}

function v6Value(text: string): bigint {
  let s = text;
  // A trailing dotted quad (::ffff:10.0.0.1) is the last two groups.
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = v4Value(tail);
    s = `${s.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head = "", rest] = s.split("::");
  const left = head ? head.split(":") : [];
  const right = rest ? rest.split(":") : [];
  const groups = rest === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

/** The address without brackets or an IPv6 zone (fe80::1%en0). */
function bare(text: string): string {
  return text.trim().replace(/^\[(.*)\]$/, "$1").split("%")[0]!;
}

/** An IP address as a number, as written: an IPv4-mapped IPv6 address stays IPv6. Null when it is not one. */
function parseRaw(text: string): Address | null {
  const s = bare(text);
  if (net.isIPv4(s)) return { version: 4, value: v4Value(s) };
  if (net.isIPv6(s)) return { version: 6, value: v6Value(s) };
  return null;
}

function isMapped(a: Address): boolean {
  return a.version === 6 && a.value >> 32n === 0xffffn;
}

/** An IP address as a number, with an IPv4-mapped IPv6 address (::ffff:a.b.c.d) as the IPv4 address it carries. */
function parseAddress(text: string): Address | null {
  const a = parseRaw(text);
  if (a && isMapped(a)) return { version: 4, value: a.value & 0xffffffffn };
  return a;
}

function formatV4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join(".");
}

/** The address in its usual form, with an IPv4-mapped IPv6 address shown as IPv4. Null when it is not an IP address. */
export function normaliseIp(text: string): string | null {
  const a = parseAddress(text);
  if (!a) return null;
  if (a.version === 4) return formatV4(a.value);
  return new URL(`http://[${bare(text)}]`).hostname.slice(1, -1);
}

function mask(version: 4 | 6, prefix: number): bigint {
  const bits = BigInt(BITS[version]);
  const all = (1n << bits) - 1n;
  return all ^ ((1n << (bits - BigInt(prefix))) - 1n);
}

function inRange(a: Address, r: Range): boolean {
  return a.version === r.version && (a.value & mask(r.version, r.prefix)) === r.value;
}

function isLoopback(a: Address): boolean {
  return a.version === 4 ? a.value >> 24n === 127n : a.value === 1n;
}

/** True for 127.0.0.0/8, ::1 and their IPv4-mapped forms. */
export function isLoopbackIp(text: string): boolean {
  const a = parseAddress(text);
  return a !== null && isLoopback(a);
}

/** One ALLOWED_IPS entry as a range, or null when it is not an address or subnet. */
function parseEntry(entry: string): Range | null {
  const [addr = "", prefixText, extra] = entry.split("/");
  if (extra !== undefined) return null;
  const raw = parseRaw(addr);
  if (!raw) return null;
  const max = BITS[raw.version];
  if (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = prefixText === undefined ? max : Number(prefixText);
  if (prefix > max) return null;
  // ::ffff:10.0.0.0/104 is 10.0.0.0/8: clients are matched in their IPv4 form.
  if (isMapped(raw) && prefix >= 96) {
    return { version: 4, value: raw.value & mask(4, prefix - 96), prefix: prefix - 96 };
  }
  return { version: raw.version, value: raw.value & mask(raw.version, prefix), prefix };
}

/**
 * ALLOWED_IPS as a list, or null when it is empty. Throws on any entry that is
 * not an address or subnet, so a typo never quietly lets everyone in or locks
 * everyone out.
 */
export function parseIpAllowList(raw: string | undefined): IpAllowList | null {
  const entries = (raw ?? "").split(",").map((e) => e.trim()).filter(Boolean);
  if (entries.length === 0) return null;
  const ranges: Range[] = [];
  const invalid: string[] = [];
  for (const entry of entries) {
    const range = parseEntry(entry);
    if (range) ranges.push(range);
    else invalid.push(entry);
  }
  if (invalid.length > 0) {
    throw new Error(
      `ALLOWED_IPS has ${invalid.length === 1 ? "an entry" : "entries"} that ${invalid.length === 1 ? "is not an IP address or subnet" : "are not IP addresses or subnets"}: ` +
        `${invalid.map((e) => `"${e}"`).join(", ")}. Use addresses and CIDR subnets, comma-separated, for example ` +
        `192.168.1.0/24,10.0.0.5,100.64.0.0/10. Host names go in ALLOWED_HOSTS.`,
    );
  }
  return {
    entries,
    allows(address: string): boolean {
      const a = parseAddress(address);
      return a !== null && (isLoopback(a) || ranges.some((r) => inRange(a, r)));
    },
  };
}

/** HOST as an IP address to listen on. Throws when it is set to anything else. */
export function parseListenHost(raw: string | undefined): string {
  const value = (raw ?? "").trim().replace(/^\[(.*)\]$/, "$1");
  if (!value) return DEFAULT_HOST;
  if (!net.isIP(value)) {
    throw new Error(
      `HOST must be an IP address to listen on, such as 127.0.0.1 (this computer only, the default), 0.0.0.0 (every IPv4 network), ` +
        `:: (every network) or one of this computer's addresses. Got "${raw}".`,
    );
  }
  return value;
}

/** HOST and ALLOWED_IPS from the environment. Throws with a message that names the setting when either is invalid. */
export function networkSettings(env: NodeJS.ProcessEnv = process.env): NetworkSettings {
  const host = parseListenHost(env.HOST);
  return { host, beyondLoopback: !isLoopbackIp(host), allowList: parseIpAllowList(env.ALLOWED_IPS) };
}

/** True when HOST opens the server beyond this computer. Never throws: an invalid HOST stops the server at startup. */
export function listensBeyondLoopback(env: NodeJS.ProcessEnv = process.env): boolean {
  const host = (env.HOST ?? "").trim();
  return host !== "" && !isLoopbackIp(host);
}

/** This computer's own IP addresses, on every interface. */
export function ownAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flatMap((list) => list ?? [])
    .map((i) => i.address);
}

/** A URL for an address and port, with an IPv6 address in brackets. */
export function addressUrl(host: string, port: number): string {
  return `http://${net.isIPv6(host) ? `[${host}]` : host}:${port}`;
}

/** Why the server can't listen, in one line that names the setting to change. */
export function listenErrorMessage(err: unknown, host: string, port: number): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === "EADDRNOTAVAIL") {
    return `HOST is ${host}, which is not an address on this computer. Use 127.0.0.1 (the default), 0.0.0.0, :: or one of this computer's own addresses.`;
  }
  if (code === "EADDRINUSE") {
    return `port ${port} on ${host} is already in use. Stop whatever is using it, or set PORT in .env to a free port.`;
  }
  return `can't listen on ${addressUrl(host, port)}: ${err instanceof Error ? err.message : String(err)}`;
}
