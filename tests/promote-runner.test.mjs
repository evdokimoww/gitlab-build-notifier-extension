import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { dismissPromoteSession } from "../promote-runner.js";
import { parseMrArgList } from "../gitlab-promote.js";

function harness(t) {
  let state = {
    activeId: "running",
    items: {
      running: { id: "running", status: "running", startedAt: 2, logs: ["Pipeline running"] },
      done: { id: "done", status: "success", startedAt: 1 },
    },
  };
  let writes = 0;
  let alarmChanges = 0;
  const previous = globalThis.chrome;
  globalThis.chrome = {
    storage: { local: {
      async get(key) {
        return typeof key === "string" ? {} : { promoteSessions: structuredClone(state) };
      },
      async set(value) { state = structuredClone(value.promoteSessions); writes++; },
    } },
    alarms: { clear() { alarmChanges++; }, create() { alarmChanges++; } },
  };
  t.after(() => { globalThis.chrome = previous; });
  return { get state() { return state; }, get writes() { return writes; },
    get alarmChanges() { return alarmChanges; } };
}

test("completed-only dismissal preserves a running session without writes or alarm changes", async t => {
  const h = harness(t);
  const before = structuredClone(h.state);
  const activeId = await dismissPromoteSession("running", { completedOnly: true });
  assert.equal(activeId, "running");
  assert.deepEqual(h.state, before);
  assert.equal(h.writes, 0);
  assert.equal(h.alarmChanges, 0);
});

test("completed-only dismissal clears finished sessions and retains the active pipeline", async t => {
  const h = harness(t);
  for (const status of ["success", "error", "cancelled", "stale"]) {
    h.state.items.done = { id: "done", status, startedAt: 1 };
    h.state.activeId = "done";
    const activeId = await dismissPromoteSession("done", { completedOnly: true });
    assert.equal(activeId, "running");
    assert.deepEqual(Object.keys(h.state.items), ["running"]);
    assert.equal(h.state.items.running.status, "running");
    assert.deepEqual(h.state.items.running.logs, ["Pipeline running"]);
  }
});

test("starting a batch persists all MR links independently of the compact session label", async () => {
  const data = {};
  const context = vm.createContext({
    URL, AbortController, structuredClone, parseMrArgList,
    runPromote: () => new Promise(() => {}),
    chrome: {
      storage: { local: {
        async get(keys) {
          return typeof keys === "string"
            ? { [keys]: data[keys] }
            : structuredClone({ ...keys, ...data });
        },
        async set(values) { Object.assign(data, structuredClone(values)); },
      } },
      alarms: { create() {}, clear() {} },
    },
  });
  const source = (await readFile(new URL("../promote-runner.js", import.meta.url), "utf8"))
    .replace(/^import .*;$/gm, "")
    .replace(/^export /gm, "");
  vm.runInContext(source, context);
  const { sessionId } = await context.acceptPromoteStart({
    mrArg: "group/app!42",
    mrBatch: "# additional MRs\nhttps://git.example.com/group/app/-/merge_requests/43\ngroup/app!42",
    sessionLabel: "!42 +1",
  }, { gitlabBaseUrl: "https://git.example.com/" });
  const session = data.promoteSessions.items[sessionId];
  assert.equal(session.mrArg, "!42 +1");
  assert.deepEqual(session.mergeRequests, [
    { project: "group/app", iid: 42, url: "https://git.example.com/group/app/-/merge_requests/42" },
    { project: "group/app", iid: 43, url: "https://git.example.com/group/app/-/merge_requests/43" },
  ]);
});

test("worker restart resumes the saved flow once using current credentials and checkpoints", async () => {
  const data = {
    gitlabBaseUrl: "https://git.example.com/", privateToken: "current-token",
    promoteSessions: { activeId: "saved", items: { saved: {
      id: "saved", status: "running", logs: [], updatedAt: Date.now(), startedAt: Date.now(),
      form: { mrArg: "team/app!42" }, gitlabBaseUrl: "https://git.example.com/",
      progress: { promoteMrIid: 7, productionBaseline: 100 },
    } } },
  };
  const runs = [];
  const context = vm.createContext({
    URL, AbortController, console,
    runPromote: (_base, token, form, hooks) => {
      runs.push({ token, form, hooks });
      return new Promise(() => {});
    },
    chrome: {
      storage: { local: {
        async get(keys) { return typeof keys === "string" ? { [keys]: data[keys] } : structuredClone({ ...keys, ...data }); },
        async set(values) { Object.assign(data, structuredClone(values)); },
      } },
      alarms: { create() {}, clear() {} },
    },
  });
  const source = (await readFile(new URL("../promote-runner.js", import.meta.url), "utf8"))
    .replace(/^import .*;$/gm, "").replace(/^export /gm, "");
  vm.runInContext(source, context);
  await Promise.all([context.reconcileStaleSessions(), context.reconcileStaleSessions()]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].token, "current-token");
  assert.equal(runs[0].form.mrArg, "team/app!42");
  assert.equal(runs[0].hooks.progress.promoteMrIid, 7);
  await runs[0].hooks.onPipelineState({ label: "MR pipeline !7", pipelineId: 101, status: "canceled", waitingForRetry: true });
  assert.match(data.promoteSessions.items.saved.statusText, /ручного перезапуска/);
  await runs[0].hooks.onProgress({ promoteMrIid: 7, productionBaseline: 100, example: true });
  assert.equal(data.promoteSessions.items.saved.progress.example, true);
  assert.equal(JSON.stringify(data.promoteSessions).includes("current-token"), false);
});

test("batch conflicts persist on affected MR links without marking other MRs", async () => {
  const base = "https://git.example.com";
  const refs = [
    { project: "team/app", iid: 42 },
    { project: "team/app", iid: 43 },
    { project: "other/app", iid: 43 },
  ];
  let state = { activeId: "batch", items: { batch: {
    id: "batch", status: "running", logs: [], startedAt: Date.now(),
    mergeRequests: refs.map(ref => ({ ...ref, url: `${base}/${ref.project}/-/merge_requests/${ref.iid}` })),
  } } };
  class ConflictError extends Error {}
  const context = vm.createContext({
    URL, DOMException, console, parseMrArgList,
    MrMergeConflictError: ConflictError,
    findNotifyTabIds: async () => [], deliverCiNotification: async () => {},
    runPromote: async (_base, _token, _form, hooks) => {
      // The hook is synchronous at its call site; pending storage updates must still finish.
      hooks.onConflict({ iid: 43, web_url: `${base}/team/app/-/merge_requests/43` }, "MR !43: конфликт");
      hooks.onConflict({ iid: 42, web_url: `${base}/team/app/-/merge_requests/42` }, "MR !42: конфликт");
      hooks.log("conflict detected");
      throw new ConflictError("merge conflict");
    },
    chrome: {
      runtime: { async sendMessage() {} },
      storage: { local: {
        async get(key) { return typeof key === "string" ? {} : { promoteSessions: structuredClone(state) }; },
        async set(value) { state = structuredClone(value.promoteSessions); },
      } },
      alarms: { create() {}, clear() {} },
    },
  });
  const source = (await readFile(new URL("../promote-runner.js", import.meta.url), "utf8"))
    .replace(/^import .*;$/gm, "").replace(/^export /gm, "");
  vm.runInContext(source, context);
  await context.executePromoteRun("batch", { mrArg: "team/app!42" }, { gitlabBaseUrl: base });
  assert.equal(state.items.batch.mergeRequests[0].conflict, "MR !42: конфликт");
  assert.equal(state.items.batch.mergeRequests[1].conflict, "MR !43: конфликт");
  assert.equal(state.items.batch.mergeRequests[2].conflict, undefined);
  assert.equal(state.items.batch.status, "error");
});

test("MR list highlights only conflicts and clears them when switching sessions", async () => {
  const element = () => ({ children: [], className: "", textContent: "",
    replaceChildren() { this.children = []; },
    appendChild(child) { this.children.push(child); },
  });
  const list = element();
  const block = element();
  const context = vm.createContext({ URL, document: {
    readyState: "loading", addEventListener() {},
    getElementById: id => ({ buildMergeRequests: list, buildMergeRequestsBlock: block })[id],
    createElement: element,
  } });
  vm.runInContext(await readFile(new URL("../promote.js", import.meta.url), "utf8"), context);
  const good = { project: "team/app", iid: 1, url: "https://git.example.com/team/app/-/merge_requests/1" };
  context.renderBuildMergeRequests({ mergeRequests: [good, { ...good, iid: 2, conflict: "MR !2: конфликт" }] });
  assert.equal(list.children[0].children[0].className, "");
  const badLink = list.children[1].children[0];
  assert.equal(badLink.className, "build-mr-conflict");
  assert.match(badLink.textContent, /Конфликт/);
  assert.equal(badLink.title, "MR !2: конфликт");
  context.renderBuildMergeRequests({ mergeRequests: [good] });
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].children[0].className, "");
  context.renderBuildMergeRequests(null);
  assert.equal(block.hidden, true);
});
