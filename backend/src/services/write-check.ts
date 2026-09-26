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

/**
 * Reads back until find() returns something, waiting before each read. A
 * read that fails counts as a miss. Undefined when every read missed.
 */
export async function readBack<T>(find: () => Promise<T | null | undefined>): Promise<T | undefined> {
  for (const ms of delaysMs) {
    await new Promise((r) => setTimeout(r, ms));
    try {
      const found = await find();
      if (found !== null && found !== undefined) return found;
    } catch {
      // A failed read is a miss; the next one may work.
    }
  }
  return undefined;
}

/** How Sophos answered, for a note: "answered 500" or "gave no answer". */
function answered(err: UnclearWriteError): string {
  return err.status ? `Sophos answered ${err.status}` : "Sophos gave no clear answer";
}

/** The note on a write Sophos answered unclearly and a read-back found done. */
export function foundNote(err: UnclearWriteError, what = "it"): string {
  return `${answered(err)}, but a read-back found ${what} on the destination, so the change was made`;
}

/** The error for an unclear write a read-back did not find: still unclear, and it says so. */
export function notFound(err: UnclearWriteError): UnclearWriteError {
  return new UnclearWriteError(`${err.reason.replace(/\.$/, "")}. A read-back did not find it yet`, err.method, err.status);
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
    if (found !== undefined) return { value: found, note: foundNote(err, what) };
    throw notFound(err);
  }
}
