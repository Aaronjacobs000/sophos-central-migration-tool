/**
 * Logging helper with secret masking, structured fields, and an in-memory
 * ring buffer that the UI can query via /api/logs to surface problems.
 */

const SECRET_KEY_REGEX = /("?(?:client[_-]?secret|authorization|token|password|api[_-]?key)"?\s*[:=]\s*"?)([^",\s]+)/gi;

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
  return input.replace(SECRET_KEY_REGEX, (_m, key) => `${key}••••••••`);
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
  const entry: LogEntry = { ts, level, message, ...meta };
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
 * is last so the UI can render newest-first by reversing.
 */
export function getRingBuffer(): LogEntry[] {
  return [...ring];
}

export function clearRingBuffer(): void {
  ring.length = 0;
}
