/**
 * What happened to a write Sophos gave no clear answer to.
 *
 * Sophos can answer 500 to a create and still make the object (seen live on
 * the detection profile API, 26/09/2026), so the API client never sends a
 * write twice (sophos-client.ts): it throws UnclearWriteError. The copies
 * then read the destination back, a few times to get past read lag, and
 * report what they find: made, with a note saying how Sophos answered, or not
 * found, with the advice to check the destination before trying again.
 */

import { UnclearWriteError } from "../sophos/client/sophos-client.js";

export { UnclearWriteError };

/** The waits before each read-back, in milliseconds: reads at about 1, 4 and 10 s. */
let delaysMs = [1000, 3000, 6000];

/** Tests shorten the waits. */
export function setReadBackDelays(ms: number[]): void {
  delaysMs = ms;
}

export function isUnclearWrite(err: unknown): err is UnclearWriteError {
  return err instanceof UnclearWriteError;
}

/** What a read-back found, or, when no read worked, why. */
export interface ReadBack<T> {
  value?: T;
  /** Set when every read failed, so nothing was read at all. */
  unread?: string;
}

/**
 * Reads back until find() returns something, waiting before each read. A
 * read that fails counts as a miss, and when every read fails the result
 * says why, so "not found" is never claimed for a destination nobody read.
 */
export async function readBack<T>(find: () => Promise<T | null | undefined>): Promise<ReadBack<T>> {
  let read = false;
  let lastError: unknown;
  for (const ms of delaysMs) {
    await new Promise((r) => setTimeout(r, ms));
    try {
      const found = await find();
      read = true;
      if (found !== null && found !== undefined) return { value: found };
    } catch (err) {
      // A failed read is a miss; the next one may work.
      lastError = err;
    }
  }
  return read ? {} : { unread: lastError instanceof Error ? lastError.message : String(lastError) };
}

/** How Sophos answered, for a note: "answered 500" or "gave no answer". */
function answered(err: UnclearWriteError): string {
  return err.status ? `Sophos answered ${err.status}` : "Sophos gave no clear answer";
}

/** The note on a write Sophos answered unclearly and a read-back found done. */
export function foundNote(err: UnclearWriteError, what = "it", where = "on the destination"): string {
  return `${answered(err)}, but a read-back found ${what} ${where}, so the change was made`;
}

/**
 * The error for an unclear write a read-back did not find, or could not
 * read (unread): still unclear, and it says which.
 */
export function notFound(err: UnclearWriteError, unread?: string): UnclearWriteError {
  const readBackSaid = unread ? `A read-back could not read the destination (${unread.replace(/\.$/, "")})` : "A read-back did not find it yet";
  return new UnclearWriteError(`${err.reason.replace(/\.$/, "")}. ${readBackSaid}`, err.method, err.status);
}

/**
 * Why an item was not sent: an earlier create in the same run, for an item
 * with the same name (or value), got no clear answer, so this one could make
 * a duplicate.
 */
export function earlierUnclear(same = "name"): string {
  return `not sent: an earlier create in this run with the same ${same} got no clear answer from Sophos, so this one could make a duplicate; check the destination, then try again`;
}

/**
 * Runs a create. When Sophos gives no clear answer, reads the destination
 * back with find(): the object and a note when it is there, else an
 * UnclearWriteError that says a read-back did not find it.
 */
export async function createChecked<T>(
  create: () => Promise<T>,
  find: () => Promise<T | null | undefined>,
  what?: string,
): Promise<{ value: T; note?: string }> {
  try {
    return { value: await create() };
  } catch (err) {
    if (!isUnclearWrite(err)) throw err;
    const found = await readBack(find);
    if (found.value !== undefined) return { value: found.value, note: foundNote(err, what) };
    throw notFound(err, found.unread);
  }
}
