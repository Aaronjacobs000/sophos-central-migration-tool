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

// With HOST off loopback, people browse to http://<this computer's IP>:<port>. A bare IP address
// can't be a rebinding attacker's name, so this computer's own addresses are accepted; names still
// need ALLOWED_HOSTS.
const os = (await import("node:os")).default;
const LAN = { address: "192.168.50.10", family: "IPv4", internal: false };
const LAN6 = { address: "fd00:abcd::10", family: "IPv6", internal: false };
const LO = { address: "127.0.0.1", family: "IPv4", internal: true };

async function withNetwork(host, fn) {
  const realInterfaces = os.networkInterfaces;
  os.networkInterfaces = () => ({ lo0: [LO], en0: [LAN, LAN6] });
  if (host === undefined) delete process.env.HOST;
  else process.env.HOST = host;
  try {
    await fn();
  } finally {
    os.networkInterfaces = realInterfaces;
    delete process.env.HOST;
  }
}

test("listening beyond loopback, this computer's IP addresses work as Host and Origin", async () => {
  fake.reset();
  await withNetwork("0.0.0.0", async () => {
    for (const host of [`192.168.50.10:${port}`, "192.168.50.10", `[fd00:abcd::10]:${port}`, `[FD00:ABCD:0:0::10]:${port}`, `127.0.0.1:${port}`, `localhost:${port}`]) {
      assert.equal((await send("GET", "/api/credentials", { host })).status, 200, host);
    }
    assert.equal((await send("GET", "/index.html", { host: `192.168.50.10:${port}` })).status, 200);
    const created = await send("POST", "/api/dest/user-groups", { host: `192.168.50.10:${port}`, origin: `http://192.168.50.10:${port}`, body: { name: "LAN users" } });
    assert.equal(created.status, 201);
    const v6 = await send("POST", "/api/dest/user-groups", { host: `[fd00:abcd::10]:${port}`, origin: `http://[fd00:abcd::10]:${port}`, body: { name: "LAN6 users" } });
    assert.equal(v6.status, 201);
    assert.equal(fake.writes().length, 2);
  });
});

test("listening beyond loopback, other names, other addresses and other sites are still refused", async () => {
  fake.reset();
  await withNetwork("::", async () => {
    for (const host of ["evil.example", `rebind.attacker.example:${port}`, "192.168.50.11", "192.168.50.10.attacker.example", "[fd00:abcd::11]"]) {
      const res = await send("GET", "/api/credentials", { host });
      assert.equal(res.status, 403, host);
      assert.equal(res.body.error, "forbidden_host");
      assert.equal(res.body.message, "Open the tool at this computer's IP address, or add the name you used to ALLOWED_HOSTS.");
    }
    for (const origin of ["https://attacker.example", `http://rebind.attacker.example:${port}`, "http://192.168.50.11", "null"]) {
      const res = await send("POST", "/api/dest/user-groups", { host: `192.168.50.10:${port}`, origin, body: { name: "x" } });
      assert.equal(res.status, 403, origin);
      assert.equal(res.body.error, "forbidden_origin");
    }
    process.env.ALLOWED_HOSTS = "migrate-box.local";
    try {
      assert.equal((await send("GET", "/api/credentials", { host: `migrate-box.local:${port}` })).status, 200);
      const res = await send("POST", "/api/dest/user-groups", { host: `migrate-box.local:${port}`, origin: `http://migrate-box.local:${port}`, body: { name: "Named users" } });
      assert.equal(res.status, 201);
    } finally {
      delete process.env.ALLOWED_HOSTS;
    }
  });
  assert.equal(fake.writes().length, 1);
});

test("on loopback (the default), this computer's other addresses are not accepted as Host", async () => {
  for (const host of [undefined, "127.0.0.1", "::1"]) {
    await withNetwork(host, async () => {
      const res = await send("GET", "/api/credentials", { host: `192.168.50.10:${port}` });
      assert.equal(res.status, 403, String(host));
      assert.equal(res.body.message, "Open the tool at http://127.0.0.1 or http://localhost.");
      assert.equal((await send("GET", "/api/credentials")).status, 200);
    });
  }
});

// Another web app on this computer shares the tool's host names but not its port, so a change must
// come from the port the request was sent to. Without that, any page on http://127.0.0.1:<other port>
// could make changes.
test("a change from a page on another port of this computer is refused, at every address the tool answers on", async () => {
  fake.reset();
  const other = port + 1;
  const cases = [
    [`127.0.0.1:${port}`, `http://127.0.0.1:${other}`],
    [`127.0.0.1:${port}`, "http://127.0.0.1"],
    [`127.0.0.1:${port}`, "https://127.0.0.1"],
    [`127.0.0.1:${port}`, `http://localhost:${port}`],
    [`localhost:${port}`, `http://localhost:${other}`],
    [`[::1]:${port}`, `http://[::1]:${other}`],
    ["127.0.0.1", `http://127.0.0.1:${other}`],
  ];
  for (const [host, origin] of cases) {
    const res = await send("POST", "/api/dest/user-groups", { host, origin, body: { name: "x" } });
    assert.equal(res.status, 403, `${host} from ${origin}`);
    assert.equal(res.body.error, "forbidden_origin");
  }
  await withNetwork("0.0.0.0", async () => {
    for (const [host, origin] of [
      [`192.168.50.10:${port}`, `http://192.168.50.10:${other}`],
      [`192.168.50.10:${port}`, "http://192.168.50.10"],
      [`[fd00:abcd::10]:${port}`, `http://[fd00:abcd::10]:${other}`],
    ]) {
      assert.equal((await send("POST", "/api/dest/user-groups", { host, origin, body: { name: "x" } })).status, 403, `${host} from ${origin}`);
    }
    // A name browsed to directly is held to its port too, default port included.
    process.env.ALLOWED_HOSTS = "migrate-box.local";
    try {
      for (const origin of [`http://migrate-box.local:${other}`, "http://migrate-box.local", "https://migrate-box.local"]) {
        assert.equal((await send("POST", "/api/dest/user-groups", { host: `migrate-box.local:${port}`, origin, body: { name: "x" } })).status, 403, origin);
      }
    } finally {
      delete process.env.ALLOWED_HOSTS;
    }
  });
  assert.deepEqual(fake.writes(), []);
});

test("a change from the tool's own port passes at every address, and so does one with no Origin", async () => {
  fake.reset();
  const cases = [
    [`127.0.0.1:${port}`, `http://127.0.0.1:${port}`],
    [`localhost:${port}`, `http://LOCALHOST:${port}`],
    [`[::1]:${port}`, `http://[::1]:${port}`],
    [`127.0.0.1:${port}`, undefined],
  ];
  for (const [host, origin] of cases) {
    assert.equal((await send("POST", "/api/dest/user-groups", { host, origin, body: { name: "Same port" } })).status, 201, `${host} from ${origin}`);
  }
  await withNetwork("0.0.0.0", async () => {
    const res = await send("POST", "/api/dest/user-groups", { host: `192.168.50.10:${port}`, origin: `http://192.168.50.10:${port}`, body: { name: "LAN" } });
    assert.equal(res.status, 201);
  });
  assert.equal(fake.writes().length, cases.length + 1);
});

test("a reverse proxy's name in ALLOWED_HOSTS passes on its default port, whatever the proxy sends as Host", async () => {
  fake.reset();
  process.env.ALLOWED_HOSTS = "migrate.example.com";
  try {
    const passes = [
      // The proxy sends the browser's Host on.
      ["migrate.example.com", "https://migrate.example.com"],
      [`migrate.example.com:8443`, "https://migrate.example.com:8443"],
      // The proxy sends its own upstream address as Host.
      [`127.0.0.1:${port}`, "https://migrate.example.com"],
      [`127.0.0.1:${port}`, "http://migrate.example.com"],
    ];
    for (const [host, origin] of passes) {
      assert.equal((await send("POST", "/api/dest/user-groups", { host, origin, body: { name: "Proxy users" } })).status, 201, `${host} from ${origin}`);
    }
    const refused = [
      // Another port on the proxy's name, with nothing in Host to say it is the tool's.
      [`127.0.0.1:${port}`, "https://migrate.example.com:8443"],
      [`127.0.0.1:${port}`, "https://not-listed.example.com"],
      ["migrate.example.com", "https://migrate.example.com:8443"],
    ];
    for (const [host, origin] of refused) {
      const res = await send("POST", "/api/dest/user-groups", { host, origin, body: { name: "x" } });
      assert.equal(res.status, 403, `${host} from ${origin}`);
      assert.equal(res.body.error, "forbidden_origin");
    }
    assert.equal(fake.writes().length, passes.length);
  } finally {
    delete process.env.ALLOWED_HOSTS;
  }
});
