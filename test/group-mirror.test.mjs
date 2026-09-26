// Group mirroring: the create API rejects an empty description, and user
// groups already on the destination are skipped and every create is audited.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createFakeSophos, SRC, DST, page } from "./helpers/fake-sophos.mjs";
import { bootApp, readAudit } from "./helpers/app.mjs";
import { startHttp } from "./helpers/http.mjs";

const fake = createFakeSophos();
const { root } = await bootApp(fake);
const { mirrorGroups, mirrorUserGroups } = await import("../backend/dist/services/group-mirror.js");
const { migrateConfigRouter } = await import("../backend/dist/routes/migrate-config.js");
const http = await startHttp([migrateConfigRouter]);
after(() => http.close());

// As the live API returns them: a group made without a description reads back as "".
const srcGroups = [
  { id: "sg-1", name: "Parent group", type: "computer", description: "" },
  { id: "sg-2", name: "Finance", type: "computer", description: "Finance laptops" },
  { id: "sg-3", name: "SQL", type: "server" },
];
fake.on(SRC, "GET", "/endpoint/v1/endpoint-groups", (req) => page(srcGroups, req.query));
fake.on(SRC, "GET", /^\/endpoint\/v1\/endpoint-groups\/[^/]+$/, (req) => {
  const g = srcGroups.find((x) => x.id === req.path.split("/").pop());
  return g ? { body: g } : { status: 404, body: { error: "NotFound" } };
});
fake.on(DST, "GET", "/endpoint/v1/endpoint-groups", (req) => page([], req.query));
// Measured on a live tenant 25/09/2026: description "" is a 400.
fake.on(DST, "POST", "/endpoint/v1/endpoint-groups", (req) =>
  req.body.description === ""
    ? { status: 400, body: { error: "badRequest", message: '400 BAD_REQUEST "Validation failure"' } }
    : { status: 201, body: { id: fake.nextId("dg"), ...req.body } });

test("groups with an empty or missing description mirror without one", async () => {
  fake.reset();
  const results = await mirrorGroups({ groupIds: ["sg-1", "sg-2", "sg-3"] });
  assert.deepEqual(results.map((r) => [r.sourceName, r.ok, r.action]), [
    ["Parent group", true, "create"],
    ["Finance", true, "create"],
    ["SQL", true, "create"],
  ]);
  const posts = fake.writes().filter((w) => w.method === "POST");
  assert.equal("description" in posts[0].body, false);
  assert.equal(posts[1].body.description, "Finance laptops");
  assert.equal("description" in posts[2].body, false);
  assert.equal(posts[2].body.type, "server");
});

test("a second source group with a name mirrored in the same run is already there, in a dry run too", async () => {
  srcGroups.push({ id: "sg-4", name: "FINANCE", type: "computer", description: "" });
  try {
    for (const dryRun of [true, false]) {
      fake.reset();
      const results = await mirrorGroups({ groupIds: ["sg-2", "sg-4", "sg-2"], dryRun });
      assert.deepEqual(results.map((r) => r.action), dryRun ? ["dry-run-create", "skip-exists", "skip-exists"] : ["create", "skip-exists", "skip-exists"]);
      assert.equal(fake.writes().length, dryRun ? 0 : 1, "before 26/09/2026 this made three groups");
    }
  } finally {
    srcGroups.pop();
  }
});

// ---- user groups ----

const srcUserGroups = [
  { id: "su-1", name: "Finance", description: "Finance staff" },
  { id: "su-2", name: "IT admins", description: "" },
  { id: "su-3", name: "Contractors" },
];
const dstUserGroups = [{ id: "du-1", name: "finance", description: "Already here" }];
fake.on(SRC, "GET", "/common/v1/directory/user-groups", (req) => page(srcUserGroups, req.query));
fake.on(DST, "GET", "/common/v1/directory/user-groups", (req) => page(dstUserGroups, req.query));
fake.on(DST, "POST", "/common/v1/directory/user-groups", (req) =>
  req.body.name === "Contractors"
    ? { status: 400, body: { error: "badRequest", message: "refused" } }
    : { status: 201, body: { id: fake.nextId("du"), ...req.body } });

test("user groups: one already on the destination is skipped, the others are created and audited", async () => {
  fake.reset();
  const before = (await readAudit(root)).length;
  const results = await mirrorUserGroups({ userGroupIds: ["su-1", "su-2", "su-3", "su-gone"] });
  assert.deepEqual(results.map((r) => [r.sourceName, r.ok, r.action]), [
    ["Finance", true, "skip-exists"],
    ["IT admins", true, "create"],
    ["Contractors", false, "create"],
    ["(unknown)", false, "create"],
  ]);
  assert.match(results[3].error, /not found/);
  const posts = fake.writes().filter((w) => w.method === "POST").map((w) => w.body);
  assert.deepEqual(posts, [{ name: "IT admins" }, { name: "Contractors" }], "no empty description is sent");
  const audit = (await readAudit(root)).slice(before);
  assert.deepEqual(audit.map((a) => [a.resource, a.ok, a.detail.name]), [["user-group", true, "IT admins"], ["user-group", false, "Contractors"]]);
});

test("user groups: a dry run writes nothing, and plans a name once", async () => {
  fake.reset();
  const results = await mirrorUserGroups({ userGroupIds: ["su-1", "su-2", "su-2"], dryRun: true });
  assert.deepEqual(results.map((r) => r.action), ["skip-exists", "dry-run-create", "skip-exists"]);
  assert.deepEqual(fake.writes(), []);
});

test("POST /api/migrate/user-groups needs IDs and returns one result per group", async () => {
  fake.reset();
  assert.equal((await http.post("/api/migrate/user-groups", {})).status, 400);
  const res = await http.post("/api/migrate/user-groups", { userGroupIds: ["su-1"], dryRun: true });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results.map((r) => [r.sourceId, r.action]), [["su-1", "skip-exists"]]);
  assert.deepEqual(fake.writes(), []);
});
