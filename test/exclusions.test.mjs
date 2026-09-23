// API #5: the remaining global exclusions copy with a duplicate check, dry
// run and audit entries, like the scanning, allowed and blocked copies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeSophos, SRC, DST, page } from "./helpers/fake-sophos.mjs";
import { bootApp, readAudit } from "./helpers/app.mjs";

const fake = createFakeSophos();
const { root } = await bootApp(fake);
const { copyExclusions } = await import("../backend/dist/services/exclusion-copier.js");

// A small in-memory store per tenant and path, with list, create and PATCH.
const store = { src: {}, dst: {} };
const PATHS = {
  isolation: "/endpoint/v1/settings/exclusions/isolation",
  "intrusion-prevention": "/endpoint/v1/settings/exclusions/intrusion-prevention",
  "exploit-mitigation": "/endpoint/v1/settings/exploit-mitigation/applications",
  "local-sites": "/endpoint/v1/settings/web-control/local-sites",
  "tls-excluded-websites": "/endpoint/v1/settings/web-control/tls-decryption/excluded-websites",
};
const failNextPost = new Set();
for (const [key, tenant] of [["src", SRC], ["dst", DST]]) {
  for (const [type, path] of Object.entries(PATHS)) {
    store[key][type] = [];
    fake.on(tenant, "GET", path, (req) => {
      let items = store[key][type];
      if (type === "exploit-mitigation" && req.query.type) items = items.filter((x) => x.type === req.query.type);
      return page(items, req.query);
    });
    if (type === "tls-excluded-websites") {
      fake.on(tenant, "PATCH", path, (req) => {
        const add = req.body?.add ?? [];
        store[key][type].push(...add);
        return { body: { added: add, removed: [] } };
      });
    } else {
      fake.on(tenant, "POST", path, (req) => {
        if (failNextPost.has(type)) {
          failNextPost.delete(type);
          return { status: 400, body: { error: "BadRequest", message: "rejected by fake" } };
        }
        const created = { id: fake.nextId(type), ...req.body, ...(type === "exploit-mitigation" ? { type: "custom" } : {}) };
        store[key][type].push(created);
        return { status: 201, body: created };
      });
    }
  }
}

function seed() {
  store.src.isolation = [
    { id: "iso-1", type: "isolation", direction: "outbound", remoteAddresses: ["10.0.0.10"], remotePorts: [53], localPorts: [], comment: "DNS" },
    { id: "iso-2", type: "isolation", direction: "both", remoteAddresses: ["10.0.0.20"], remotePorts: [], localPorts: [], comment: "" },
  ];
  store.dst.isolation = [
    { id: "iso-9", type: "isolation", direction: "outbound", remoteAddresses: ["10.0.0.10"], remotePorts: [53], localPorts: [], comment: "DNS" },
  ];
  store.src["intrusion-prevention"] = [
    { id: "ips-1", type: "intrusionPrevention", direction: "inbound", remoteAddresses: ["10.5.0.0/16"], remotePorts: [], localPorts: [3389], comment: "Jump hosts" },
  ];
  store.dst["intrusion-prevention"] = [];
  store.src["exploit-mitigation"] = [
    { id: "app-1", name: "erp.exe", paths: ["$programfiles\\ERP\\erp.exe"], type: "custom" },
    { id: "app-2", name: "chrome.exe", paths: ["C:\\chrome.exe"], type: "detected" },
  ];
  store.dst["exploit-mitigation"] = [];
  store.src["local-sites"] = [
    { id: "ls-1", url: "ERP.example.test", tags: ["Allow ERP"], comment: "ERP" },
    { id: "ls-2", url: "files.example.test", categoryId: 17 },
  ];
  store.dst["local-sites"] = [{ id: "ls-9", url: "erp.example.test", tags: ["Allow ERP"] }];
  store.src["tls-excluded-websites"] = [
    { value: "bank.example.test", comment: "pinning" },
    { value: "10.10.0.0/16" },
    { value: "fe80::1" },
  ];
  store.dst["tls-excluded-websites"] = [{ value: "BANK.example.test" }];
}

const all = {
  isolation: ["iso-1", "iso-2"],
  "intrusion-prevention": ["ips-1"],
  "exploit-mitigation": ["app-1"],
  "local-sites": ["ls-1", "ls-2"],
  "tls-excluded-websites": ["bank.example.test", "10.10.0.0/16", "fe80::1"],
};

test("dry run: plans creates and skips, and writes nothing", async () => {
  seed();
  fake.reset();
  const before = (await readAudit(root)).length;
  const results = await copyExclusions({ selections: all, dryRun: true });
  assert.equal(fake.writes().length, 0);
  assert.equal((await readAudit(root)).length, before);
  const by = (type, id) => results.find((r) => r.type === type && r.sourceId === id);
  assert.equal(by("isolation", "iso-1").action, "skip-exists");
  assert.equal(by("isolation", "iso-2").action, "dry-run-create");
  assert.equal(by("intrusion-prevention", "ips-1").action, "dry-run-create");
  assert.equal(by("exploit-mitigation", "app-1").action, "dry-run-create");
  assert.equal(by("local-sites", "ls-1").action, "skip-exists", "URL match ignores case");
  assert.equal(by("local-sites", "ls-2").action, "dry-run-create");
  assert.equal(by("tls-excluded-websites", "bank.example.test").action, "skip-exists");
  assert.equal(by("tls-excluded-websites", "fe80::1").action, "dry-run-create");
  // Only custom exploit mitigation applications are read.
  const exploitReads = fake.calls.filter((c) => c.path === PATHS["exploit-mitigation"]);
  assert.ok(exploitReads.every((c) => c.query.type === "custom"));
});

test("real copy: creates missing items with write-safe bodies and audits each", async () => {
  seed();
  fake.reset();
  const before = (await readAudit(root)).length;
  const results = await copyExclusions({ selections: all });
  const writes = fake.writes();
  assert.ok(writes.every((w) => w.tenant === "dst"), "writes only go to the destination");
  const posts = (type) => writes.filter((w) => w.path === PATHS[type]);

  const [iso] = posts("isolation");
  assert.deepEqual(iso.body, { direction: "both", remoteAddresses: ["10.0.0.20"] });
  const [ips] = posts("intrusion-prevention");
  assert.deepEqual(ips.body, { direction: "inbound", localPorts: [3389], remoteAddresses: ["10.5.0.0/16"], comment: "Jump hosts" });
  const [app] = posts("exploit-mitigation");
  assert.deepEqual(app.body, { paths: ["$programfiles\\ERP\\erp.exe"] });
  const [site] = posts("local-sites");
  assert.deepEqual(site.body, { url: "files.example.test", categoryId: 17 });
  const tls = posts("tls-excluded-websites");
  assert.equal(tls.length, 1, "one PATCH for the batch");
  assert.equal(tls[0].method, "PATCH");
  assert.deepEqual(tls[0].body, { add: [{ value: "10.10.0.0/16" }, { value: "fe80::1" }] });

  assert.equal(results.filter((r) => r.action === "create" && r.ok).length, 6);
  assert.equal(results.filter((r) => r.action === "skip-exists").length, 3);

  const entries = (await readAudit(root)).slice(before);
  assert.equal(entries.length, 5, "four creates and one TLS update");
  assert.ok(entries.every((e) => e.ok && e.side === "dest" && e.tenantId === DST.tenantId));
  assert.deepEqual(entries.map((e) => e.resource).sort(), ["exploit-mitigation", "intrusion-prevention", "isolation", "local-sites", "tls-excluded-websites"]);
});

test("a rejected create is reported and audited as a failure", async () => {
  seed();
  fake.reset();
  failNextPost.add("isolation");
  const before = (await readAudit(root)).length;
  const results = await copyExclusions({ selections: { isolation: ["iso-2"] } });
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /rejected by fake/);
  const [entry] = (await readAudit(root)).slice(before);
  assert.equal(entry.ok, false);
  assert.equal(entry.resource, "isolation");
});

test("lists follow every page when pageTotal says there are more", async () => {
  store.src.isolation = Array.from({ length: 130 }, (_, i) => ({ id: `iso-${i}`, direction: "outbound", remoteAddresses: [`10.1.${i}.1`] }));
  store.dst.isolation = [];
  fake.reset();
  const results = await copyExclusions({ selections: { isolation: ["iso-129"] }, dryRun: true });
  assert.equal(results[0].action, "dry-run-create", "item on page 2 was found");
  const pagesRead = fake.calls.filter((c) => c.tenant === "src" && c.path === PATHS.isolation).map((c) => c.query.page);
  assert.deepEqual(pagesRead, ["1", "2"]);
});
