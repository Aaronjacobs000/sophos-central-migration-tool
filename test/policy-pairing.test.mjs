// A source policy pairs with the same destination policy on the Policies page,
// in the deep match, on Compare and in a clone or overwrite: the exact name
// first, else the one name that matches ignoring case and surrounding spaces.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createFakeSophos, SRC, DST, page } from "./helpers/fake-sophos.mjs";
import { bootApp } from "./helpers/app.mjs";
import { startHttp } from "./helpers/http.mjs";

const fake = createFakeSophos();
await bootApp(fake);
const backend = await import("../backend/dist/compare/policy-pairing.js");
const frontend = await import("../frontend/js/policy-pairing.js");
const { computeDeepMatch, compareRouter } = await import("../backend/dist/routes/compare.js");
const { migratePolicies } = await import("../backend/dist/services/policy-migrator.js");
const http = await startHttp([compareRouter]);
after(() => http.close());

const pol = (id, name, type = "application-control") => ({ id, name, type, enabled: true, enforced: false, priority: 1, settings: {} });

// ---- the rule, the same in the backend and in the Policies page's copy ----

const RULES = [
  {
    name: "an exact match wins over one that ignores case",
    sources: [pol("s1", "Developers")],
    dests: [pol("d1", "developers"), pol("d2", "Developers")],
    want: { s1: ["d2", false] },
  },
  {
    name: "a single match ignoring case and surrounding spaces pairs",
    sources: [pol("s1", "Developers"), pol("s2", " Finance ")],
    dests: [pol("d1", "developers"), pol("d2", "FINANCE")],
    want: { s1: ["d1", false], s2: ["d2", false] },
  },
  {
    name: "two matches ignoring case pair with nothing",
    sources: [pol("s1", "Developers")],
    dests: [pol("d1", "developers"), pol("d2", "DEVELOPERS ")],
    want: { s1: [null, true] },
  },
  {
    name: "two source policies matching one destination policy ignoring case pair with nothing",
    sources: [pol("s1", "Developers"), pol("s2", "DEVELOPERS")],
    dests: [pol("d1", "developers")],
    want: { s1: [null, true], s2: [null, true] },
  },
  {
    name: "a destination policy paired by its exact name is not also paired ignoring case",
    sources: [pol("s1", "Developers"), pol("s2", "developers")],
    dests: [pol("d1", "Developers")],
    want: { s1: ["d1", false], s2: [null, false] },
  },
  {
    name: "one taken by its exact name leaves a single match ignoring case",
    sources: [pol("s1", "Developers"), pol("s2", "DEVELOPERS")],
    dests: [pol("d1", "developers"), pol("d2", "DEVELOPERS")],
    want: { s1: ["d1", false], s2: ["d2", false] },
  },
  {
    name: "only the same type pairs",
    sources: [pol("s1", "Developers")],
    dests: [pol("d1", "Developers", "web-control"), pol("d2", "developers", "web-control")],
    want: { s1: [null, false] },
  },
];

for (const [side, { pairPolicy }] of [["backend", backend], ["page", frontend]]) {
  for (const rule of RULES) {
    test(`${side}: ${rule.name}`, () => {
      for (const [id, [destId, ambiguous]] of Object.entries(rule.want)) {
        const got = pairPolicy(rule.sources.find((p) => p.id === id), rule.sources, rule.dests);
        assert.deepEqual([got.dest?.id ?? null, got.ambiguous], [destId, ambiguous], id);
      }
    });
  }
}

test("the page's copy of the rule is the backend's, line for line", async () => {
  const ts = await readFile(new URL("../backend/src/compare/policy-pairing.ts", import.meta.url), "utf8");
  const js = await readFile(new URL("../frontend/js/policy-pairing.js", import.meta.url), "utf8");
  // The function body, with the TypeScript types taken out.
  const body = (src) => {
    const start = src.indexOf("  const srcs =");
    assert.ok(start > 0, "found the function body");
    return src.slice(start).replace(/<P extends NamedPolicy>|: P\[\]|: NamedPolicy\[\]|!(?=,)/g, "");
  };
  assert.equal(body(js), body(ts));
});

// ---- the fake tenants ----

const policies = { src: [], dst: [] };
for (const [tenant, side] of [[SRC, "src"], [DST, "dst"]]) {
  fake.on(tenant, "GET", "/endpoint/v1/policies", (req) => page(policies[side], req.query));
  fake.on(tenant, "GET", /^\/endpoint\/v1\/policies\/[^/]+$/, (req) => {
    const p = policies[side].find((x) => x.id === req.path.split("/").pop());
    return p ? { body: p } : { status: 404, body: { error: "NotFound", message: "no such policy" } };
  });
}
fake.on(DST, "POST", "/endpoint/v1/policies", (req) => ({ status: 201, body: { id: fake.nextId("pol"), ...req.body } }));
fake.on(DST, "PATCH", /^\/endpoint\/v1\/policies\/[^/]+$/, (req) => ({ body: { id: req.path.split("/").pop(), ...req.body } }));

const settings = { "endpoint.application-control.enabled": { value: true } };
const full = (id, name) => ({ ...pol(id, name), settings });

// "Developers" pairs with "developers"; "Finance" matches two destination policies ignoring case.
function seed() {
  policies.src = [full("s1", "Developers"), full("s2", "Finance")];
  policies.dst = [full("d1", "developers"), full("d2", "finance"), full("d3", "FINANCE")];
}

test("deep match: a single match ignoring case is compared, two are left unpaired", async () => {
  seed();
  const res = await computeDeepMatch();
  const rows = res.matches.map((m) => `${m.sourceId ?? "-"} ${m.destId ?? "-"} ${m.status}`).sort();
  assert.deepEqual(rows, ["- d2 dest-only", "- d3 dest-only", "s1 d1 match", "s2 - source-only"]);
});

test("Compare: opens the policy paired ignoring case, and says why an ambiguous one has none", async () => {
  seed();
  let res = (await http.get("/api/compare/policies/s1")).body;
  assert.equal(res.destPolicy.id, "d1");
  assert.deepEqual(res.summary, { added: 0, removed: 0, changed: 0 });

  res = (await http.get("/api/compare/policies/s2")).body;
  assert.equal(res.destPolicy, null);
  assert.equal(res.ambiguous, true);
  assert.match(res.note, /more than one policy matches this name ignoring case/);

  policies.dst = [];
  res = (await http.get("/api/compare/policies/s2")).body;
  assert.equal(res.ambiguous, false);
  assert.equal(res.note, "no matching destination policy found");
});

test("clone: a policy paired ignoring case is already there, an ambiguous one is not cloned and says why", async () => {
  seed();
  fake.reset();
  const res = await migratePolicies({ policyIds: ["s1", "s2"] });
  assert.deepEqual(res.map((r) => `${r.sourceId} ${r.action} ${r.ok}`), ["s1 skip-exists true", "s2 create false"]);
  assert.equal(res[0].destId, "d1");
  assert.match(res[1].error, /^more than one policy of this type matches "Finance" ignoring case, so the tool can't tell which destination policy is its copy and did not clone it/);
  assert.deepEqual(fake.writes(), [], "before 26/09/2026 this made a third Finance policy");

  // Nor is it overwritten, and a dry run says the same.
  for (const opts of [{ overwrite: true }, { dryRun: true }]) {
    const [r] = await migratePolicies({ policyIds: ["s2"], ...opts });
    assert.equal(r.ok, false);
    assert.match(r.error, /matches "Finance" ignoring case/);
  }
  assert.deepEqual(fake.writes(), []);
});

test("Compare and the Policies page offer no Clone for an ambiguous name", async () => {
  const compare = await readFile(new URL("../frontend/js/page-policy-compare.js", import.meta.url), "utf8");
  assert.match(compare, /\$\{state\.ambiguous && !state\.destPolicy \? "" : `<button id="clone-btn"/);
  assert.match(compare, /getElementById\("clone-btn"\)\?\.addEventListener/);
  assert.match(compare, /a clone would add yet another/);
  const policies = await readFile(new URL("../frontend/js/page-policies.js", import.meta.url), "utf8");
  assert.match(policies, /const action = inDest \|\| ambiguous\s*\?\s*`<button class="btn btn-small" data-compare=/);
});

test("overwrite: writes to the policy Compare paired, ignoring case", async () => {
  seed();
  fake.reset();
  const [res] = await migratePolicies({ policyIds: ["s1"], overwrite: true });
  assert.equal(res.action, "overwrite");
  const [patch] = fake.writes();
  assert.equal(patch.method, "PATCH");
  assert.equal(patch.path, "/endpoint/v1/policies/d1");
  assert.equal(patch.body.name, "Developers");
});

test("the Policies page ticks and pairs rows with the shared rule, and deep match records by ID", async () => {
  const js = await readFile(new URL("../frontend/js/page-policies.js", import.meta.url), "utf8");
  assert.match(js, /import \{ pairPolicy \} from "\.\/policy-pairing\.js";/);
  assert.match(js, /pairPolicy\(p, srcList, dstList\)/);
  assert.match(js, /const inDest = !!dest;/);
  assert.match(js, /const inSource = pairedDestIds\.has\(p\.id\);/);
  assert.match(js, /\$\{ambiguous \? AMBIGUOUS_TAG : ""\}/);
  // No pairing by name left on the page.
  assert.doesNotMatch(js, /Names\.has\(/);
  assert.doesNotMatch(js, /matchByKey/);
  assert.match(js, /map\.set\(`source:\$\{m\.sourceId\}`, m\)/);
  assert.match(js, /map\.set\(`dest:\$\{m\.destId\}`, m\)/);
});
