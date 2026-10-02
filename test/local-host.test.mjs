// A page on another site can reach 127.0.0.1 by DNS rebinding: its own name, pointed at 127.0.0.1.
// Its requests carry that name in Host, so the server answers loopback names only, and a change
// must come from the tool's own pages when the browser sends an Origin.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import { createFakeSophos, SRC, DST } from "./helpers/fake-sophos.mjs";
import { bootApp, readAudit } from "./helpers/app.mjs";

const fake = createFakeSophos();
const { root } = await bootApp(fake);

const express = (await import("express")).default;
const { localHostOnly } = await import("../backend/dist/middleware/local-host.js");
const { errorHandler } = await import("../backend/dist/middleware/error-handler.js");
const { credentialsRouter } = await import("../backend/dist/routes/credentials.js");
const { groupsRouter } = await import("../backend/dist/routes/groups.js");

// Mounted as server.ts mounts them.
const app = express();
app.use(localHostOnly);
app.use(express.json());
app.use("/api", credentialsRouter);
app.use("/api", groupsRouter);
app.use(express.static(path.join(process.cwd(), "frontend")));
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address();
after(() => new Promise((r) => server.close(r)));

fake.on(DST, "POST", "/common/v1/directory/user-groups", (req) => ({ status: 201, body: { id: "ug-1", ...req.body } }));

/** A request with the Host and Origin a browser would send. */
function send(method, p, { host, origin, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers = { Host: host ?? `127.0.0.1:${port}` };
    if (origin) headers.Origin = origin;
    if (data) Object.assign(headers, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { text += c; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, body: json });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const EVIL = `rebind.attacker.example:${port}`;

test("a request that names another host gets nothing: no tenant data, no page, no write", async () => {
  fake.reset();
  const before = (await readAudit(root)).length;
  const creds = await send("GET", "/api/credentials", { host: EVIL });
  assert.equal(creds.status, 403);
  assert.equal(creds.body.error, "forbidden_host");
  assert.doesNotMatch(creds.text, new RegExp(SRC.clientId));

  assert.equal((await send("GET", "/index.html", { host: EVIL })).status, 403);

  // Same-origin JSON from the rebound page, so the origin check alone would not stop it.
  const write = await send("POST", "/api/dest/user-groups", { host: EVIL, origin: `http://${EVIL}`, body: { name: "x" } });
  assert.equal(write.status, 403);
  const swap = await send("PUT", "/api/credentials", { host: EVIL, origin: `http://${EVIL}`, body: { mode: "partner", destTenantId: "x" } });
  assert.equal(swap.status, 403);
  assert.match(await readFile(path.join(root, ".env"), "utf8"), /^CREDENTIAL_MODE=direct$/m, ".env unchanged");

  for (const host of ["evil.example", "127.0.0.1.attacker.example", "localhost.attacker.example", "127.0.0.1@attacker.example"]) {
    assert.equal((await send("GET", "/api/credentials", { host })).status, 403, `Host: ${host}`);
  }
  assert.deepEqual(fake.writes(), []);
  assert.equal((await readAudit(root)).length, before);
});

test("the tool's own pages still work on 127.0.0.1 and localhost", async () => {
  fake.reset();
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, "127.0.0.1"]) {
    const res = await send("GET", "/api/credentials", { host });
    assert.equal(res.status, 200, host);
    assert.equal(res.body.direct.source.clientId, SRC.clientId);
  }
  assert.equal((await send("GET", "/index.html")).status, 200);
  const created = await send("POST", "/api/dest/user-groups", { origin: `http://127.0.0.1:${port}`, body: { name: "Finance users" } });
  assert.equal(created.status, 201);
  const viaLocalhost = await send("POST", "/api/dest/user-groups", { host: `localhost:${port}`, origin: `http://localhost:${port}`, body: { name: "Sales users" } });
  assert.equal(viaLocalhost.status, 201);
  assert.equal(fake.writes().length, 2);
});

test("a change from a page on another site is refused even when it reaches 127.0.0.1 by name", async () => {
  fake.reset();
  for (const origin of ["https://attacker.example", "null", `http://rebind.attacker.example:${port}`]) {
    const res = await send("POST", "/api/dest/user-groups", { origin, body: { name: "x" } });
    assert.equal(res.status, 403, origin);
    assert.equal(res.body.error, "forbidden_origin");
  }
  // A read from another site is left to the browser, which never shows it that site's page.
  assert.equal((await send("GET", "/api/credentials", { origin: "https://attacker.example" })).status, 200);
  assert.deepEqual(fake.writes(), []);
});

test("ALLOWED_HOSTS adds a reverse proxy's name", async () => {
  process.env.ALLOWED_HOSTS = " Migrate.Example.com , other.example ";
  try {
    assert.equal((await send("GET", "/api/credentials", { host: "migrate.example.com" })).status, 200);
    const res = await send("POST", "/api/dest/user-groups", { host: "migrate.example.com", origin: "https://migrate.example.com", body: { name: "Proxy users" } });
    assert.equal(res.status, 201);
    assert.equal((await send("GET", "/api/credentials", { host: "attacker.example" })).status, 403);
  } finally {
    delete process.env.ALLOWED_HOSTS;
  }
  assert.equal((await send("GET", "/api/credentials", { host: "migrate.example.com" })).status, 403);
});

test("server.ts checks the host before the body parser and every route", async () => {
  const src = await readFile(new URL("../backend/src/server.ts", import.meta.url), "utf8");
  const guard = src.indexOf("app.use(localHostOnly)");
  assert.ok(guard > 0, "server.ts mounts localHostOnly");
  for (const later of ["app.use(express.json", 'app.use("/api"', "app.use(express.static"]) {
    assert.ok(src.indexOf(later) > guard, `${later} comes after the host check`);
  }
});
