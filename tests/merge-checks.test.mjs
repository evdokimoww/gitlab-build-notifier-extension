import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = (await readFile(new URL("../gitlab-promote.js", import.meta.url), "utf8"))
  .replace(/^import[\s\S]*?from "\.\/gitlab-api.js";/m, "")
  .replace(/^export /gm, "");

function harness(statuses, overrides = {}) {
  let now = 0;
  let current;
  let merges = 0;
  const base = { iid: 5588, state: "opened", source_branch: "feature", target_branch: "develop", sha: "head" };
  const ctx = vm.createContext({
    DOMException, Date: { now: () => now },
    getMergeRequest: async () => {
      current = { ...base, ...(statuses.length > 1 ? statuses.shift() : statuses[0]) };
      return current;
    },
    listMrPipelines: async () => [],
    mergeMergeRequest: async () => {
      merges++;
      assert.equal(current.merge_status, "can_be_merged", "merge must wait for GitLab checks");
      return { ...current, state: "merged" };
    },
    ...overrides,
  });
  vm.runInContext(source, ctx);
  ctx.sleep = async (_ms, signal) => { ctx.checkAborted(signal); now += 1000; };
  return { ctx, get merges() { return merges; }, run: options => ctx.mergeIfNeeded("api", "token", "project", base, {
    dryRun: false, label: "Feature 3/4", waitPipelineBefore: false,
    pipelineTimeout: 3, pollSec: 1, log() {}, hooks: {}, ...options,
  }) };
}

for (const status of ["checking", "unchecked", "preparing", "approvals_syncing"]) {
  test(`merge waits while GitLab reports ${status}`, async () => {
    const h = harness([{ merge_status: status === "checking" ? "checking" : "can_be_merged", detailed_merge_status: status }, { merge_status: "can_be_merged", detailed_merge_status: "mergeable" }]);
    assert.equal((await h.run()).state, "merged");
    assert.equal(h.merges, 1);
  });
}

test("checking has a timeout and does not send merge", async () => {
  const h = harness([{ merge_status: "checking" }]);
  await assert.rejects(h.run(), /проверка.*3 с/);
  assert.equal(h.merges, 0);
});

test("checking can be cancelled", async () => {
  const abort = new AbortController();
  const h = harness([{ merge_status: "checking" }]);
  h.ctx.sleep = async () => { abort.abort(); };
  await assert.rejects(h.run({ signal: abort.signal }), e => e.name === "AbortError");
  assert.equal(h.merges, 0);
});

test("a real conflict after checking is still reported", async () => {
  const h = harness([{ merge_status: "checking" }, { merge_status: "cannot_be_merged", has_conflicts: true }]);
  await assert.rejects(h.run(), /конфликт/);
  assert.equal(h.merges, 0);
});

test("verified SHA is checked again after GitLab checking", async () => {
  const h = harness([{ merge_status: "checking" }, { merge_status: "can_be_merged", sha: "changed" }]);
  await assert.rejects(h.run({ verifiedSha: "head" }), /изменился/);
  assert.equal(h.merges, 0);
});


test("405 during a new GitLab check is retried after checks settle", async () => {
  const ready = { merge_status: "can_be_merged", detailed_merge_status: "mergeable" };
  const h = harness([ready, { merge_status: "checking" }, ready]);
  let attempts = 0;
  h.ctx.mergeMergeRequest = async () => {
    if (++attempts === 1) throw new Error('GitLab 405: "405 Method Not Allowed"');
    return { state: "merged" };
  };
  assert.equal((await h.run()).state, "merged");
  assert.equal(attempts, 2);
});

for (const code of [403, 405]) {
  test(`${code} without pending checks remains an error`, async () => {
    const h = harness([{ merge_status: "can_be_merged" }]);
    let attempts = 0;
    h.ctx.mergeMergeRequest = async () => { attempts++; throw new Error(`GitLab ${code}`); };
    await assert.rejects(h.run(), new RegExp(`GitLab ${code}`));
    assert.equal(attempts, 1);
  });
}

test("target branch is checked again after checking", async () => {
  const h = harness([{ merge_status: "checking" }, { merge_status: "can_be_merged", target_branch: "master" }]);
  await assert.rejects(h.run(), /Target.*изменился/);
  assert.equal(h.merges, 0);
});

test("pipeline success is followed by fresh merge checks", async () => {
  const ready = { merge_status: "can_be_merged" };
  const h = harness([ready, { merge_status: "checking" }, ready]);
  h.ctx.ensureMrPipelineStarted = async () => {};
  h.ctx.waitPipelineLoop = async () => 10;
  assert.equal((await h.run({ waitPipelineBefore: true })).state, "merged");
  assert.equal(h.merges, 1);
});

test("SHA changes during pipeline wait block merge", async () => {
  const h = harness([{ merge_status: "can_be_merged" }, { merge_status: "can_be_merged", sha: "new-head" }]);
  h.ctx.ensureMrPipelineStarted = async () => {};
  h.ctx.waitPipelineLoop = async () => 10;
  await assert.rejects(h.run({ waitPipelineBefore: true }), /изменился/);
  assert.equal(h.merges, 0);
});
