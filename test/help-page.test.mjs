// The Help page carries the README's hosting note.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const help = await readFile(new URL("../frontend/help.html", import.meta.url), "utf8");
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

test("Help says there is no sign-in and how to share the tool, as the README does", () => {
  const security = help.slice(help.indexOf("<h2>Security</h2>"), help.indexOf("<h2>Useful links</h2>"));
  for (const phrase of [
    "The tool has no sign-in of its own.",
    "shares its connection and its jobs, and the audit log does not record who made a change",
    "run it on a server behind your own sign-in, for example a reverse proxy with single sign-on on the same server that forwards to",
    "127.0.0.1:3100",
  ]) {
    assert.ok(security.includes(phrase), `Help: ${phrase}`);
    assert.ok(readme.includes(phrase), `README: ${phrase}`);
  }
});
