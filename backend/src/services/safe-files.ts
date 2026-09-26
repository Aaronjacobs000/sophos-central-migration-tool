/**
 * Reading and saving the tool's local files so that a crash never leaves one
 * cut off and a brief lock doesn't fail the call.
 *
 * File operations retry on EBUSY / EPERM / EACCES: OneDrive (and other
 * cloud-sync tools) and antivirus briefly lock files, which causes transient
 * failures on Windows.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { log } from "../log.js";

/** Codes that indicate a transient file lock (OneDrive, antivirus, etc.). */
const RETRYABLE_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);
const MAX_RETRIES = 5;
let baseDelayMs = 150;

/** The wait before the first retry on a locked file, doubled for each one after. Tests shorten it. */
export function setRetryDelay(ms: number): void {
  baseDelayMs = ms;
}

export function isLock(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return !!code && RETRYABLE_CODES.has(code);
}

/**
 * Run a file operation, retrying while the file is locked (at most `retries`
 * times, 5 by default). Retries are logged under `section`.
 */
export async function withRetry<T>(section: string, label: string, fn: () => Promise<T>, retries = MAX_RETRIES): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code && RETRYABLE_CODES.has(code) && attempt < retries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        log.emit("warn", section, `${label}: ${code}, retry ${attempt + 1}/${retries} in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

export interface SaveOptions {
  /** The log section for retries. */
  section: string;
  /** Mode for the files a save creates, set on the file again once it is saved. */
  mode?: number;
  /** The error to throw when the save fails, from why and the file that could not be saved. */
  failed?: (err: unknown, file: string) => Error;
}

/** A file's text, or null when there is no such file. */
export async function readText(file: string, section: string): Promise<string | null> {
  try {
    return await withRetry(section, `read ${path.basename(file)}`, () => fs.readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Write a file and flush it to disk. */
async function writeFlushed(file: string, text: string, mode?: number): Promise<void> {
  const handle = await fs.open(file, "w", mode);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Save a file whole: write a temp file beside it, then rename it over the
 * file, so a crash leaves the old file or the new one and a reader never sees
 * part of one. OneDrive and antivirus can hold the file on Windows, which
 * makes the rename fail even when a write would succeed. If the rename is
 * still locked after its retries and inPlaceIsSafe() agrees, the file is
 * written in place instead.
 */
export async function saveFile(
  file: string,
  text: string,
  opts: SaveOptions & { inPlaceIsSafe?: () => Promise<boolean> },
): Promise<void> {
  const fail = (err: unknown) => (opts.failed ? opts.failed(err, file) : err);
  const name = path.basename(file);
  const temp = path.join(path.dirname(file), `.${name}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`);
  try {
    await withRetry(opts.section, `write ${name} (temp file)`, () => writeFlushed(temp, text, opts.mode));
    await withRetry(opts.section, `replace ${name}`, () => fs.rename(temp, file));
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => {});
    if (!isLock(err) || !opts.inPlaceIsSafe || !(await opts.inPlaceIsSafe())) throw fail(err);
    try {
      await withRetry(opts.section, `write ${name}`, () => writeFlushed(file, text, opts.mode));
    } catch (writeErr) {
      throw fail(writeErr);
    }
    // Logged once the write has worked: a write in place that fails is reported by the error alone.
    log.emit("warn", opts.section, `${name} stayed locked (${(err as NodeJS.ErrnoException).code}), so it was written in place.`);
  }
  // A mode only applies when a file is created, and a file written in place keeps its own.
  if (opts.mode !== undefined) await fs.chmod(file, opts.mode).catch(() => {});
}

/** Where a file kept with a backup was read from: the file, its backup, or neither. */
export type ReadFrom = "file" | "backup" | "none";

/**
 * A file kept with a backup, as readWithBackup found it. An error is why that
 * copy could not be used; a copy with no error and no value is missing.
 */
export type BackedUpRead<T> =
  | { from: "file"; value: T }
  | { from: "backup"; value: T; fileError?: unknown }
  | { from: "none"; fileError?: unknown; backupError?: unknown };

/**
 * Read a file saved with saveWithBackup. When the file is missing or can't be
 * read or parsed (cut off by a crash mid-save, or held by another program),
 * the backup is used, which holds the last save or a newer one.
 */
export async function readWithBackup<T>(
  file: string,
  backup: string,
  parse: (raw: string) => T,
  section: string,
): Promise<BackedUpRead<T>> {
  let fileError: unknown;
  try {
    const raw = await readText(file, section);
    if (raw !== null) return { from: "file", value: parse(raw) };
  } catch (err) {
    fileError = err;
  }
  try {
    const raw = await readText(backup, section);
    if (raw !== null) return { from: "backup", value: parse(raw), fileError };
    return { from: "none", fileError };
  } catch (err) {
    return { from: "none", fileError, backupError: err };
  }
}

/**
 * Save a file and its backup: the backup first, then the file, so the backup
 * always holds the last save or a newer one. The backup is written in place
 * only while the file holds a whole copy, and the file only once the backup
 * holds this one, so one of the two is always whole. `from` is where the
 * saved data was read from.
 */
export async function saveWithBackup(file: string, backup: string, text: string, from: ReadFrom, opts: SaveOptions): Promise<void> {
  await saveFile(backup, text, { ...opts, inPlaceIsSafe: async () => from !== "backup" });
  await saveFile(file, text, { ...opts, inPlaceIsSafe: async () => (await readText(backup, opts.section).catch(() => null)) === text });
}
