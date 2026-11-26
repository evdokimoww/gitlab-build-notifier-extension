import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = (await readFile(new URL("../gitlab-promote.js", import.meta.url), "utf8"))
  .replace(/^import[\s\S]*?from "\.\/gitlab-api.js";/m, "")
  .replace(/^export /gm, "");

function harness() {
  const context = vm.createContext({ DOMException, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  vm.runInContext("sleep = async (_ms, signal) => checkAborted(signal)", context);
  return context;
}

for (const status of ["failed", "canceled"]) {
  for (const newPipeline of [false, true]) {
    test(`${status}: manual ${newPipeline ? "new pipeline" : "retry"} resumes waiting`, async () => {
      const ctx = harness();
      const snapshots = [
        [{ id: 10, status, sha: "head" }],
        [{ id: newPipeline ? 11 : 10, status: "running", sha: "head" }],
        [{ id: newPipeline ? 11 : 10, status: "success", sha: "head" }],
      ];
      const states = [];
      let starts = 0;
      const id = await ctx.waitPipelineLoop(async () => snapshots.shift(), {
        timeoutSec: 10, pollSec: 0, log() {}, label: "branch pipeline develop",
        onNoPipeline: async () => { starts++; },
        onPipelineState: async state => states.push(structuredClone(state)),
      });
      assert.equal(id, newPipeline ? 11 : 10);
      assert.equal(starts, 0);
      assert.ok(states.some(s => s.waitingForRetry));
      assert.equal(states.at(-1).waitingForRetry, false);
    });
  }
}

test("waiting for manual retry can be cancelled", async () => {
  const ctx = harness();
  const abort = new AbortController();
  await assert.rejects(ctx.waitPipelineLoop(async () => {
    abort.abort();
    return [{ id: 10, status: "canceled" }];
  }, { timeoutSec: 10, pollSec: 0, signal: abort.signal, log() {}, label: "MR pipeline !1" }),
  error => error.name === "AbortError");
});

test("a stale successful commit does not override the latest failed commit", () => {
  const ctx = harness();
  assert.equal(ctx.selectPipelineForWait([
    { id: 11, sha: "head", status: "failed" },
    { id: 10, sha: "old", status: "success" },
  ]).id, 11);
});


test("an older success on the same SHA cannot hide a new cancellation", () => {
  const ctx = harness();
  assert.equal(ctx.selectPipelineForWait([
    { id: 10, sha: "head", status: "success" },
    { id: 11, sha: "head", status: "canceled" },
  ]).id, 11);
});

test("a skipped API pipeline does not hide an active push on the same SHA", () => {
  const ctx = harness();
  assert.equal(ctx.selectPipelineForWait([
    { id: 11, sha: "head", status: "skipped", source: "api" },
    { id: 10, sha: "head", status: "running", source: "push" },
  ]).id, 10);
});

test("manual retry waiting still respects the configured timeout and logs once", async () => {
  const ctx = harness();
  let now = 1000;
  ctx.Date = { now: () => now };
  ctx.sleep = async () => { now += 1000; };
  const logs = [];
  await assert.rejects(ctx.waitPipelineLoop(async () => [{ id: 10, status: "failed" }], {
    timeoutSec: 3, pollSec: 1, log: line => logs.push(line), label: "MR pipeline !1",
  }), /не успел за 3 с/);
  assert.equal(logs.filter(line => line.includes("Ждём ручного перезапуска")).length, 1);
});
