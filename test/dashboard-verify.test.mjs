// The dashboard's Verify step says when a job has failures, even while other
// jobs, or other devices in the same job, are still moving.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { verifySummary } from "../frontend/js/migration-view.js";

const job = (status, failed = 0, expired = 0) => ({ status, progress: { failed, expired } });

test("failures come before jobs in progress, and each job is counted once", () => {
  const jobs = [
    job("in-progress"),
    job("requested"),
    job("completed"),
    job("completed-with-failures", 1),
    job("in-progress"),
    job("in-progress", 4), // still moving, but four devices failed
  ];
  assert.deepEqual(verifySummary(jobs), {
    state: "bad",
    tag: "2 need a look",
    line: "<b>6</b> jobs: 1 completed, 3 in progress, 2 with failures",
  });
  assert.equal(verifySummary([job("in-progress"), job("requested", 0, 1)]).tag, "1 needs a look");
  assert.equal(verifySummary([job("failed", 2)]).state, "bad");
});

test("no failures: in progress, then completed", () => {
  assert.deepEqual(verifySummary([job("in-progress"), job("requested"), job("completed")]), {
    state: "warn",
    tag: "2 in progress",
    line: "<b>3</b> jobs: 1 completed, 2 in progress",
  });
  assert.deepEqual(verifySummary([job("completed")]), { state: "ok", tag: "All completed", line: "<b>1</b> job: 1 completed, 0 in progress" });
  const withCancelled = verifySummary([job("completed"), job("cancelled")]);
  assert.equal(withCancelled.tag, "1 completed");
  assert.match(withCancelled.line, /, 1 cancelled$/);
});

test("the dashboard draws the Verify step from verifySummary", async () => {
  const js = await readFile(new URL("../frontend/js/page-dashboard.js", import.meta.url), "utf8");
  assert.match(js, /const \{ state, tag, line \} = verifySummary\(data\.jobs\);/);
  assert.doesNotMatch(js, /in progress`/);
});
