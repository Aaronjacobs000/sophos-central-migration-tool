// The row menu deletes on the Policies, Groups and Exclusions pages are
// writes, so each one is in data/audit.log, done or failed, as the web
// filtering deletes already were. Before 26/09/2026 none was recorded.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createFakeSophos, DST } from "./helpers/fake-sophos.mjs";
import { bootApp, readAudit } from "./helpers/app.mjs";
import { startHttp } from "./helpers/http.mjs";

const fake = createFakeSophos();
const { root } = await bootApp(fake);
const { policiesRouter } = await import("../backend/dist/routes/policies.js");
const { groupsRouter } = await import("../backend/dist/routes/groups.js");
const { exclusionsRouter } = await import("../backend/dist/routes/exclusions.js");
const http = await startHttp([policiesRouter, groupsRouter, exclusionsRouter]);
after(() => http.close());

const DELETES = [
  ["/api/dest/policies/p-1", "/endpoint/v1/policies/p-1", "policy"],
  ["/api/dest/groups/g-1", "/endpoint/v1/endpoint-groups/g-1", "endpoint-group"],
  ["/api/dest/user-groups/u-1", "/common/v1/directory/user-groups/u-1", "user-group"],
  ["/api/dest/exclusions/scanning/e-1", "/endpoint/v1/settings/exclusions/scanning/e-1", "scanning"],
  ["/api/dest/exclusions/allowed-items/e-2", "/endpoint/v1/settings/allowed-items/e-2", "allowed-items"],
  ["/api/dest/exclusions/blocked-items/e-3", "/endpoint/v1/settings/blocked-items/e-3", "blocked-items"],
];
const refused = new Set();
fake.on(DST, "DELETE", /.*/, (req) =>
  refused.has(req.path) ? { status: 404, body: { error: "resourceNotFound", message: "not found" } } : { status: 204 });

test("each row delete is audited with its resource and ID", async () => {
  const before = (await readAudit(root)).length;
  for (const [route, sophosPath] of DELETES) {
    assert.equal((await http.del(route)).status, 204, route);
    assert.ok(fake.writes().some((w) => w.method === "DELETE" && w.path === sophosPath));
  }
  const entries = (await readAudit(root)).slice(before);
  assert.deepEqual(
    entries.map((e) => [e.side, e.tenantId, e.action, e.resource, e.resourceId, e.ok]),
    DELETES.map(([route, , resource]) => ["dest", DST.tenantId, "delete", resource, route.split("/").pop(), true]),
  );
});

test("a refused delete is audited with the error", async () => {
  refused.add("/endpoint/v1/policies/p-gone");
  const before = (await readAudit(root)).length;
  const res = await http.del("/api/dest/policies/p-gone");
  assert.notEqual(res.status, 204);
  const [entry] = (await readAudit(root)).slice(before);
  assert.deepEqual([entry.action, entry.resource, entry.resourceId, entry.ok], ["delete", "policy", "p-gone", false]);
  assert.match(entry.error, /404/);
});
