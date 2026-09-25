// Endpoint group mirroring: the create API rejects an empty description.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeSophos, SRC, DST, page } from "./helpers/fake-sophos.mjs";
import { bootApp } from "./helpers/app.mjs";

const fake = createFakeSophos();
await bootApp(fake);
const { mirrorGroups } = await import("../backend/dist/services/group-mirror.js");

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
