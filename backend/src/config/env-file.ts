/**
 * Atomic, comment-preserving .env reader/writer.
 *
 * We manage the .env file directly rather than via dotenv's writer so that
 * user comments and unrelated keys survive a round-trip from the UI.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { isLock, readText, saveFile } from "../services/safe-files.js";

/** Log section for lock retries on .env. */
const SECTION = "credentials";

export interface EnvFile {
  path: string;
  lines: EnvLine[];
}

export type EnvLine =
  | { kind: "blank" }
  | { kind: "comment"; text: string }
  | { kind: "entry"; key: string; value: string; originalLine: string };

const ENTRY_REGEX = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/;

export async function readEnvFile(filePath: string): Promise<EnvFile> {
  // Retried while OneDrive or antivirus holds the file.
  const content = await readText(filePath, SECTION);
  if (content === null) {
    return { path: filePath, lines: [] };
  }

  const rawLines = content.split(/\r?\n/);
  // Trailing empty final line artifact from split
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }

  const lines: EnvLine[] = rawLines.map((raw) => {
    const trimmed = raw.trim();
    if (trimmed === "") return { kind: "blank" };
    if (trimmed.startsWith("#")) return { kind: "comment", text: raw };

    const match = ENTRY_REGEX.exec(raw);
    if (!match) return { kind: "comment", text: raw };

    let value = match[2] ?? "";
    // Strip surrounding double quotes if present
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    return { kind: "entry", key: match[1]!, value, originalLine: raw };
  });

  return { path: filePath, lines };
}

export function getEnvValue(file: EnvFile, key: string): string | undefined {
  for (const line of file.lines) {
    if (line.kind === "entry" && line.key === key) {
      return line.value;
    }
  }
  return undefined;
}

export function setEnvValues(
  file: EnvFile,
  updates: Record<string, string | undefined>,
): EnvFile {
  const lines = [...file.lines];
  const remaining = new Set(Object.keys(updates));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.kind !== "entry") continue;
    if (!Object.prototype.hasOwnProperty.call(updates, line.key)) continue;

    const newValue = updates[line.key];
    remaining.delete(line.key);

    if (newValue === undefined) continue;
    lines[i] = {
      kind: "entry",
      key: line.key,
      value: newValue,
      originalLine: formatEntryLine(line.key, newValue),
    };
  }

  // Append any keys that weren't already in the file.
  for (const key of remaining) {
    const value = updates[key];
    if (value === undefined) continue;
    lines.push({
      kind: "entry",
      key,
      value,
      originalLine: formatEntryLine(key, value),
    });
  }

  return { path: file.path, lines };
}

function formatEntryLine(key: string, value: string): string {
  // Quote values that contain whitespace or #, otherwise leave bare.
  const needsQuote = /[\s#"'`\\]/.test(value);
  const escaped = value.replace(/"/g, '\\"');
  return needsQuote ? `${key}="${escaped}"` : `${key}=${value}`;
}

export function renderEnvFile(file: EnvFile): string {
  const lines: string[] = [];
  for (const line of file.lines) {
    if (line.kind === "blank") {
      lines.push("");
    } else if (line.kind === "comment") {
      lines.push(line.text);
    } else {
      lines.push(formatEntryLine(line.key, line.value));
    }
  }
  // Ensure trailing newline for POSIX tooling
  return lines.join(os.EOL) + os.EOL;
}

/**
 * Atomic write: render to a temp file (mode 0600) in the same directory then
 * rename. Prevents a crashed write from leaving a half-written .env on disk.
 * Both steps retry while OneDrive or antivirus holds the file, and a save
 * that still fails removes its temp file (safe-files.ts).
 */
export async function writeEnvFile(file: EnvFile): Promise<void> {
  const dir = path.dirname(file.path);
  await fs.mkdir(dir, { recursive: true });
  await saveFile(file.path, renderEnvFile(file), { section: SECTION, mode: 0o600, failed: saveError });
}

/** An error that says .env was not saved, and for a lock, what usually holds it. */
function saveError(err: unknown, file: string): Error {
  const reason = isLock(err)
    ? `${path.basename(file)} stayed locked (${(err as NodeJS.ErrnoException).code}), usually by OneDrive or antivirus. Try again`
    : err instanceof Error ? err.message : String(err);
  return new Error(`Couldn't save the credentials: ${reason}.`, { cause: err });
}

/**
 * Reflect the current file values back into process.env. Only sets keys we
 * explicitly manage so we don't clobber things like PATH.
 */
export function applyEnvToProcess(file: EnvFile, managedKeys: string[]): void {
  for (const key of managedKeys) {
    const value = getEnvValue(file, key);
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}
