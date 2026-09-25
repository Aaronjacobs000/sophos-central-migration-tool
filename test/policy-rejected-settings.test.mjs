// A policy write can be refused for many settings in one error; all of them are dropped at once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeSophos, SRC, DST, page } from "./helpers/fake-sophos.mjs";
import { bootApp } from "./helpers/app.mjs";

const fake = createFakeSophos();
await bootApp(fake);
const { migratePolicies, rejectedSettings } = await import("../backend/dist/services/policy-migrator.js");

// As the live source returned it 25/09/2026: a web profile policy made in the
// console reads back ten file type actions as "inherit", which writes refuse.
const FILETYPES = ["exe-msi", "exe-javabytecode", "exe-unknown", "exe-ocx", "exe-com", "video-flv", "archive-jar", "exe-exe", "exe-dll", "doc-pdf"]
  .map((t) => `endpoint.web-control.filetypes.${t}.action`);
const source = {
  id: "web-1", name: "Web device", type: "web-control", enabled: true, priority: 2,
  settings: {
    "endpoint.web-control.web-profile.enabled": { value: true },
    "endpoint.web-control.categories.1.action": { value: "inherit" },
    ...Object.fromEntries(FILETYPES.map((k) => [k, { value: "inherit" }])),
  },
};
fake.on(SRC, "GET", /^\/endpoint\/v1\/policies\/[^/]+$/, () => ({ body: source }));
fake.on(DST, "GET", "/endpoint/v1/policies", (req) => page([], req.query));
fake.on(DST, "POST", "/endpoint/v1/policies", (req) => {
  const bad = FILETYPES.filter((k) => req.body.settings[k]?.value === "inherit");
  if (bad.length) {
    return { status: 400, body: { error: "badRequest", message: bad.map((k) => `Must provide an allowed value for setting (${k}).`).join(" "), correlationId: "c-1" } };
  }
  return { status: 201, body: { id: "new-1", ...req.body } };
});

test("every setting named in one error is dropped, then the create succeeds", async () => {
  fake.reset();
  const [res] = await migratePolicies({ policyIds: ["web-1"] });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.action, "create");
  const posts = fake.writes().filter((w) => w.method === "POST");
  assert.equal(posts.length, 2, "one refused create, one retry");
  for (const k of FILETYPES) assert.equal(k in posts[1].body.settings, false);
  assert.equal(posts[1].body.settings["endpoint.web-control.categories.1.action"].value, "inherit", "settings the error did not name stay");
  assert.equal(res.adjustments.length, FILETYPES.length);
  assert.match(res.adjustments[0], /^dropped setting endpoint\.web-control\.filetypes\.exe-msi\.action: destination rejected it \(Must provide an allowed value for setting \(endpoint\.web-control\.filetypes\.exe-msi\.action\)\)$/);
});

test("rejectedSettings reads each named setting once, with its own sentence", () => {
  const msg = "Sophos API error 400: badRequest - Must provide an allowed value for setting (a.b.c). Must not provide a unit for setting (d.e). Must provide an allowed value for setting (a.b.c). (correlationId: x)";
  assert.deepEqual(rejectedSettings(msg), [
    { key: "a.b.c", reason: "Must provide an allowed value for setting (a.b.c)" },
    { key: "d.e", reason: "Must not provide a unit for setting (d.e)" },
  ]);
});
