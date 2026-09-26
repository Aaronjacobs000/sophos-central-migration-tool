/**
 * Logging helper with secret masking, structured fields, and an in-memory
 * ring buffer that the UI can query via /api/logs to surface problems.
 */

const SECRET_KEY_REGEX = /("?(?:client[_-]?secret|authorization|token|password|api[_-]?key)"?\s*[:=]\s*"?)([^",\s]+)/gi;
/** Field names whose string values are masked in structured detail (token, fromToken, clientSecret...). */
const SECRET_FIELD_REGEX = /token|secret|password|authorization|api[_-]?key/i;
const MASK = "••••••••";

/**
 * Exact secret values to mask wherever they appear, whatever the field name
 * or message format. The device migrator registers each handshake token.
 */
const secretValues = new Set<string>();

const RING_CAPACITY = 500;

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  message: string;
  /** Coarse-grained section the log belongs to (e.g. "preload", "credentials", "migration"). */
  section?: string;
  /** Optional source/dest tag for tenant-related entries. */
  side?: "source" | "dest";
  /** Optional structured detail bag. */
  detail?: Record<string, unknown>;
}

const ring: LogEntry[] = [];

function maskString(input: string): string {
  let out = input.replace(SECRET_KEY_REGEX, (_m, key) => `${key}${MASK}`);
  for (const value of secretValues) out = out.split(value).join(MASK);
  return out;
}

/** Mask this exact value in every later log line, detail bag and error response. */
export function registerSecret(value: string | null | undefined): void {
  if (typeof value === "string" && value.length >= 8) secretValues.add(value);
}

/** Mask secrets in a string that leaves the server some other way (an error response). */
export function maskSecrets(input: string): string {
  return maskString(input);
}

/**
 * Copy of a detail bag with secret-named fields and registered secret values
 * masked. The copy is taken when the line is written, so the ring buffer never
 * holds the live object (the receiver job response carries the handshake token).
 */
function redactDetail(detail: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!detail) return detail;
  try {
    return JSON.parse(
      JSON.stringify(detail, (key, value) => {
        if (typeof value !== "string") return value;
        return key && SECRET_FIELD_REGEX.test(key) ? MASK : maskString(value);
      }),
    ) as Record<string, unknown>;
  } catch {
    return { unserialisable: maskString(String(detail)) };
  }
}

function redactEntry(entry: LogEntry): LogEntry {
  return { ...entry, message: maskString(entry.message), detail: redactDetail(entry.detail) };
}

function mask(input: unknown): string {
  if (typeof input === "string") return maskString(input);
  if (input instanceof Error) return maskString(input.stack ?? input.message);
  try {
    return maskString(JSON.stringify(input));
  } catch {
    return String(input);
  }
}

function pushRing(entry: LogEntry): void {
  ring.push(entry);
  if (ring.length > RING_CAPACITY) ring.shift();
}

function emit(level: LogLevel, parts: unknown[], meta?: Partial<LogEntry>): void {
  const ts = new Date().toISOString();
  const message = parts.map(mask).join(" ");
  const entry: LogEntry = { ts, level, message, ...meta, detail: redactDetail(meta?.detail) };
  pushRing(entry);
  const tag = meta?.section ? `[${meta.section}${meta.side ? `:${meta.side}` : ""}]` : "";
  const line = `[${ts}] ${level.padEnd(5)} ${tag} ${message}`.trim();
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info(...parts: unknown[]) {
    emit("info", parts);
  },
  warn(...parts: unknown[]) {
    emit("warn", parts);
  },
  error(...parts: unknown[]) {
    emit("error", parts);
  },
  /**
   * Structured log call. Same shape as info/warn/error but you supply the
   * level + section/side metadata so the logs page can filter on them.
   */
  emit(
    level: LogLevel,
    section: string,
    message: string,
    options?: { side?: "source" | "dest"; detail?: Record<string, unknown> },
  ): void {
    emit(level, [message], { section, side: options?.side, detail: options?.detail });
  },
};

/**
 * Snapshot the ring buffer for the /api/logs route. The most recent entry
 * is last so the UI can render newest-first by reversing. Entries are masked
 * again on the way out, which also covers secrets registered after a line was
 * written.
 */
export function getRingBuffer(): LogEntry[] {
  return ring.map(redactEntry);
}

export function clearRingBuffer(): void {
  ring.length = 0;
}
