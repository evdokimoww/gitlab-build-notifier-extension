import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { guaranteeDevelopBranch, parseBranchMappings } from "../gitlab-promote.js";
import * as api from "../gitlab-api.js";

const source = (await readFile(new URL("../gitlab-promote.js", import.meta.url), "utf8"))
  .replace(/^import[\s\S]*?from "\.\/gitlab-api.js";/m, "")
  .replace(/^export /gm, "");

function harness(overrides = {}) {
  const calls = [];
  const main = { iid: 1, source_branch: "fix", target_branch: "master", state: "opened", sha: "feature", title: "Fix" };
  const backport = { iid: 2, source_branch: "guarantee/mr-1-merge", target_branch: "develop", state: "opened", sha: "picked" };
  let masterMerged = false;
  const context = vm.createContext({
    URL, DOMException, setTimeout, clearTimeout, ...api,
    getMergeRequest: async (_a, _t, _p, iid) => {
      calls.push(["getMR", iid]);
      return structuredClone(iid === 1 ? main : backport);
    },
    branchExists: async (_a, _t, _p, branch) => branch === "develop",
    listPipelinesForRef: async (_a, _t, _p, branch) => [{
      id: masterMerged ? 11 : 10, status: "success", source: "push", ref: branch,
      sha: branch === "master" ? "merge" : "picked",
    }],
    listMrPipelines: async () => [{ id: 12, status: "success", sha: "picked" }],
    mergeMergeRequest: async (_a, _t, _p, iid, sha) => {
      calls.push(["merge", iid, sha]);
      if (iid === 1) {
        masterMerged = true;
        Object.assign(main, { state: "merged", merge_commit_sha: main.merge_commit_sha || "merge" });
      } else backport.state = "merged";
      return structuredClone(iid === 1 ? main : backport);
    },
    getCommit: async () => ({ parent_ids: ["a", "b"] }),
    createBranch: async (_a, _t, _p, branch, ref) => calls.push(["branch", branch, ref]),
    cherryPickCommit: async (_a, _t, _p, sha, branch) => calls.push(["pick", sha, branch]),
    createMergeRequest: async (_a, _t, _p, params) => {
      calls.push(["createMR", params]);
      return structuredClone(backport);
    },
    listBackportMergeRequests: async () => [],
    ...overrides,
  });
  vm.runInContext(source, context);
  // Skip timers without replacing merge orchestration or pipeline validation.
  vm.runInContext("sleep = async () => {}", context);
  const images = [];
  context.extractBuildImage = async () => "registry/app:master";
  return { context, calls, main, backport, images,
    run: (options, hooks = {}) => context.runPromote("https://git.example.com", "token",
      { mrArg: "team/app!1", pipelineTimeoutSec: 0.02, ...options },
      { onBuildImage: image => images.push(image), ...hooks }),
    plan: options => context.planPromote("https://git.example.com", "token", { mrArg: "team/app!1", ...options }),
  };
}

test("reverse masks retain prefixes, suffixes, main and custom naming", () => {
  for (const [target, expected] of [["master", "develop"], ["main", "develop"],
    ["team/master", "team/develop"], ["master-env", "develop-env"],
    ["team/main-env", "team/develop-env"]]) {
    assert.equal(guaranteeDevelopBranch(target), expected);
  }
  assert.equal(guaranteeDevelopBranch("develop"), null);
  assert.equal(guaranteeDevelopBranch("prod-eu", parseBranchMappings("stage-* → prod-*")), "stage-eu");
  assert.throws(() => guaranteeDevelopBranch("master", parseBranchMappings("develop → master\nstaging → master")), /неоднозначная/);
});

test("analysis identifies Guarantee and shows master build and pipeline-gated backport", async () => {
  const h = harness();
  const plan = await h.plan();
  assert.equal(plan.flow, "guarantee");
  assert.equal(plan.productionBranch, "master");
  assert.equal(plan.developBranch, "develop");
  assert.deepEqual(Array.from(plan.steps, s => s.kind), ["guarantee-merge", "build", "cherry-pick", "backport"]);
  assert.equal(h.calls.some(c => c[0] === "merge"), false);
});

test("standard promote still plans develop to master", async () => {
  const h = harness();
  h.main.target_branch = "develop";
  const plan = await h.plan({ dryRun: true });
  assert.notEqual(plan.flow, "guarantee");
  assert.deepEqual(Array.from(plan.steps, s => s.kind), ["feature", "develop-build", "promote", "build"]);
});

test("missing develop and conflicting production override fail before merge", async () => {
  const h = harness({ branchExists: async () => false });
  await assert.rejects(h.plan(), /не найдена/);
  await assert.rejects(h.run(), /не найдена/);
  assert.equal(h.calls.some(c => c[0] === "merge"), false);
  await assert.rejects(h.plan({ productionBranch: "main" }), /Очистите/);
});

test("full flow merges master, cherry-picks whole merge and gates develop on current SHA", async () => {
  const h = harness();
  const result = await h.run();
  assert.equal(result.buildImage, "registry/app:master");
  assert.deepEqual(h.images, ["registry/app:master"]);
  assert.deepEqual(h.calls.filter(c => c[0] === "merge"), [["merge", 1, undefined], ["merge", 2, "picked"]]);
  assert.deepEqual(h.calls.find(c => c[0] === "branch"), ["branch", "guarantee/mr-1-merge", "develop"]);
  assert.deepEqual(h.calls.find(c => c[0] === "pick"), ["pick", "merge", "guarantee/mr-1-merge"]);
  assert.ok(h.calls.findIndex(c => c[0] === "merge") < h.calls.findIndex(c => c[0] === "pick"));
});

test("master image is published while backport is still waiting", async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const h = harness({ cherryPickCommit: () => waiting });
  const run = h.run();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.images, ["registry/app:master"]);
  assert.equal(h.calls.some(c => c[0] === "merge" && c[1] === 2), false);
  release();
  await run;
});

test("failed cherry-pick retains the master image and does not merge develop", async () => {
  const h = harness({ cherryPickCommit: async () => { throw new Error("conflict"); } });
  await assert.rejects(h.run(), /Cherry-pick.*conflict/);
  assert.deepEqual(h.images, ["registry/app:master"]);
  assert.equal(h.calls.some(c => c[0] === "createMR" || c[0] === "merge" && c[1] === 2), false);
});

test("failed, skipped and stale success pipelines never allow develop merge", async () => {
  for (const pipeline of [{ status: "failed", sha: "picked" }, { status: "skipped", sha: "picked" },
    { status: "success", sha: "old" }]) {
    const h = harness({
      listMrPipelines: async () => [{ id: 20, ...pipeline }],
      listPipelinesForRef: async (_a, _t, _p, ref) => ref === "master"
        ? [{ id: 11, status: "success", sha: "merge" }]
        : [{ id: 20, ...pipeline }],
      createMrPipeline: async () => ({ id: 21 }),
    });
    await assert.rejects(h.run({ skipBuildImage: true }));
    assert.equal(h.calls.some(c => c[0] === "merge" && c[1] === 2), false);
  }
});

test("dry run and stop flags preserve their boundaries", async () => {
  const dry = harness();
  await dry.run({ dryRun: true });
  assert.equal(dry.calls.some(c => ["merge", "pick", "branch", "createMR"].includes(c[0])), false);
  const stop = harness();
  await stop.run({ stopAfterFeature: true });
  assert.deepEqual(stop.calls.filter(c => c[0] === "merge").map(c => c[1]), [1]);
  assert.equal(stop.calls.some(c => c[0] === "pick"), false);
  const create = harness();
  await create.run({ stopAfterPromoteMr: true });
  assert.equal(create.calls.some(c => c[0] === "createMR"), true);
  assert.equal(create.calls.some(c => c[0] === "merge" && c[1] === 2), false);
  assert.equal(create.images.length, 1);
});

test("repeat run reuses an already merged cherry-pick MR", async () => {
  const h = harness({ listBackportMergeRequests: async () => [{ iid: 2, state: "merged" }] });
  h.main.state = "merged";
  h.main.merge_commit_sha = "merge";
  await h.run();
  assert.equal(h.calls.some(c => ["pick", "branch", "createMR", "merge"].includes(c[0])), false);
});

test("squash and fast-forward transfer the full changeset", async () => {
  const squash = harness();
  squash.main.squash_commit_sha = "squash";
  await squash.run();
  assert.equal(squash.calls.find(c => c[0] === "pick")[1], "squash");
  const ff = harness({
    getCommit: async () => ({ parent_ids: ["b"] }),
    listMrCommits: async () => [{ id: "b", parent_ids: ["a"] }, { id: "a", parent_ids: ["base"] }],
  });
  ff.main.merge_commit_sha = "b";
  await ff.run();
  assert.deepEqual(ff.calls.filter(c => c[0] === "pick").map(c => c[1]), ["a", "b"]);
});

test("orphaned partial cherry-pick branch fails without applying commits twice", async () => {
  const h = harness({ branchExists: async () => true });
  await assert.rejects(h.run(), /уже существует/);
  assert.equal(h.calls.some(c => c[0] === "pick"), false);
});

test("REST helpers encode branch/commit names and send SHA merge precondition", async t => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
    return { ok: true, text: async () => "{}" };
  };
  t.after(() => { globalThis.fetch = previousFetch; });
  const base = "https://git.example.com/api/v4/";
  await api.createBranch(base, "token", "team/app", "guarantee/mr-1", "team/develop");
  await api.cherryPickCommit(base, "token", "team/app", "a/b", "guarantee/mr-1");
  await api.mergeMergeRequest(base, "token", "team/app", 2, "tested-sha");
  assert.match(requests[0].url, /projects\/team%2Fapp\/repository\/branches$/);
  assert.deepEqual(requests[0].body, { branch: "guarantee/mr-1", ref: "team/develop" });
  assert.match(requests[1].url, /commits\/a%2Fb\/cherry_pick$/);
  assert.equal(requests[1].body.branch, "guarantee/mr-1");
  assert.equal(requests[2].body.sha, "tested-sha");
  assert.equal(requests[2].body.should_remove_source_branch, false);
});

test("batch may not mix production and develop targets", async () => {
  const h = harness({ getMergeRequest: async (_a, _t, _p, iid) => ({
    iid, target_branch: iid === 1 ? "master" : "develop", source_branch: `fix-${iid}`, state: "opened",
  }) });
  await assert.rejects(h.plan({ mrBatch: "team/app!2" }), /одну целевую ветку/);
  assert.equal(h.calls.some(c => c[0] === "merge"), false);
});

test("analysis flag boundaries match execution", async () => {
  const h = harness();
  assert.deepEqual(Array.from((await h.plan({ stopAfterFeature: true })).steps, s => s.kind), ["guarantee-merge"]);
  assert.deepEqual(Array.from((await h.plan({ stopAfterPromoteMr: true })).steps, s => s.kind),
    ["guarantee-merge", "build", "cherry-pick"]);
  assert.deepEqual(Array.from((await h.plan({ skipBuildImage: true })).steps, s => s.kind),
    ["guarantee-merge", "cherry-pick", "backport"]);
});

test("fast-forward history with an internal merge does not duplicate side-branch patches", async () => {
  const h = harness({
    getCommit: async () => ({ parent_ids: ["m"] }),
    listMrCommits: async () => [
      { id: "head", parent_ids: ["m"] }, { id: "side", parent_ids: ["a"] },
      { id: "m", parent_ids: ["a", "side"] }, { id: "a", parent_ids: ["base"] },
    ],
  });
  h.main.merge_commit_sha = "head";
  await h.run();
  assert.deepEqual(h.calls.filter(c => c[0] === "pick").map(c => c[1]), ["a", "m", "head"]);
});

test("background writes preserve master image and concurrent logs on backport failure", async () => {
  let state = { activeId: "test", items: { test: {
    id: "test", status: "running", logs: [], startedAt: Date.now(),
  } } };
  const runner = (await readFile(new URL("../promote-runner.js", import.meta.url), "utf8"))
    .replace(/^import .*;$/gm, "").replace(/^export /gm, "");
  const context = vm.createContext({
    URL, DOMException, console,
    parseMrArgList: () => [{ project: "team/app", iid: 1 }],
    MrMergeConflictError: class extends Error {},
    findNotifyTabIds: async () => [], deliverCiNotification: async () => {},
    runPromote: async (_base, _token, _form, hooks) => {
      await Promise.all([hooks.log("master merged"), hooks.log("cherry-pick started"),
        hooks.onBuildImage("registry/app:master"), hooks.heartbeat()]);
      throw new Error("cherry-pick failed");
    },
    chrome: {
      alarms: { create() {}, clear() {} },
      runtime: { sendMessage: async () => {} },
      storage: { local: {
        async get(keys) {
          if (typeof keys === "string") return {};
          return { ...keys, promoteSessions: structuredClone(state) };
        },
        async set(value) { state = structuredClone(value.promoteSessions); },
      } },
    },
  });
  vm.runInContext(runner, context);
  await context.executePromoteRun("test", { mrArg: "team/app!1" }, { gitlabBaseUrl: "https://git.example.com" });
  assert.equal(state.items.test.buildImage, "registry/app:master");
  assert.deepEqual(Array.from(state.items.test.logs).slice(0, 2), ["master merged", "cherry-pick started"]);
  assert.equal(state.items.test.status, "error");
});


test("manual backport retry after worker restart reuses MR and never repeats merge or picks", async () => {
  let created = false;
  let retried = false;
  const h = harness({
    listBackportMergeRequests: async () => created ? [structuredClone(h.backport)] : [],
    createMergeRequest: async () => { created = true; h.calls.push(["createMR"]); return structuredClone(h.backport); },
    listMrPipelines: async () => [{ id: retried ? 21 : 20, status: retried ? "success" : "canceled", sha: "picked" }],
    listPipelinesForRef: async (_a, _t, _p, ref) => [{ id: ref === "master" ? (h.main.state === "merged" ? 11 : 10) : 20,
      status: ref === "master" ? "success" : "canceled", sha: ref === "master" ? "merge" : "picked" }],
    createMrPipeline: async () => { assert.fail("must wait for manual retry"); },
  });
  const progress = {};
  await assert.rejects(h.run({}, { progress, onPipelineState: state => {
    if (state.waitingForRetry) throw new Error("worker stopped");
  } }), /worker stopped/);
  assert.equal(progress.guaranteeBaseline, 10);
  retried = true;
  const result = await h.run({}, { progress });
  assert.equal(result.buildImage, "registry/app:master");
  assert.equal(h.calls.filter(c => c[0] === "merge" && c[1] === 1).length, 1);
  assert.equal(h.calls.filter(c => c[0] === "pick").length, 1);
  assert.equal(h.calls.filter(c => c[0] === "createMR").length, 1);
  assert.equal(h.calls.filter(c => c[0] === "merge" && c[1] === 2).length, 1);
});

test("standard flow recovers at production build with the same promote MR and baseline", async () => {
  let productionMerged = false;
  let finish = false;
  let mrReads = 0;
  const h = harness({
    branchExists: async () => true,
    getProject: async () => ({ default_branch: "master" }),
    listPipelinesForRef: async (_a, _t, _p, ref) => [{
      id: ref === "develop" ? (h.main.state === "merged" ? 11 : 10) : (productionMerged ? 21 : 20),
      status: ref === "master" && productionMerged && !finish ? "failed" : "success",
      sha: ref === "develop" ? "feature" : "production", source: "push",
    }],
    listMrPipelines: async () => [{ id: 15, status: ++mrReads === 1 ? "running" : "success", sha: "feature" }],
    listOpenMergeRequests: async () => [],
    mergeMergeRequest: async (_a, _t, _p, iid) => {
      h.calls.push(["merge", iid]);
      const mr = iid === 1 ? h.main : h.backport;
      mr.state = "merged";
      if (iid === 2) productionMerged = true;
      return structuredClone(mr);
    },
  });
  h.main.target_branch = "develop";
  Object.assign(h.backport, { source_branch: "develop", target_branch: "master", sha: "feature" });
  const progress = {};
  await assert.rejects(h.run({}, { progress, onPipelineState: state => {
    if (state.waitingForRetry) throw new Error("worker stopped");
  } }), /worker stopped/);
  assert.equal(progress.developBaseline, 10);
  assert.equal(progress.productionBaseline, 20);
  assert.equal(progress.promoteMrIid, 2);
  finish = true;
  assert.equal((await h.run({}, { progress })).buildImage, "registry/app:master");
  assert.deepEqual(h.calls.filter(c => c[0] === "merge"), [["merge", 1], ["merge", 2]]);
  assert.equal(h.calls.filter(c => c[0] === "createMR").length, 1);
});
