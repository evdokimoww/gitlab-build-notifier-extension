import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { getBuildImages } from "../mr-build-image.js";

const background = (await readFile(new URL("../background.js", import.meta.url), "utf8"))
  .replace(/^import[\s\S]*?;\r?$/gm, "");
const image = "registry.example.com/team/app:260909.1618-42";
const job = { id: 42, name: "build", stage: "Build", status: "success", finished_at: "2020-01-01" };
const tab = { id: 1, url: "https://git.example.com/team/app/-/merge_requests/7" };

function storage(initial = {}) {
  const data = { ...initial };
  return {
    async get(keys) {
      if (keys === null) return { ...data };
      if (typeof keys === "string") return { [keys]: data[keys] };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map(k => [k, data[k]]));
      return { ...keys, ...data };
    },
    async set(values) { Object.assign(data, values); },
  };
}

function harness({ notified = false, jobs = [job], tabs = [tab] } = {}) {
  const event = { addListener() {} };
  const calls = { displays: [], notices: [], reads: 0 };
  const state = { jobs, pipeline: 10 };
  const chrome = {
    storage: {
      local: storage({ gitlabBaseUrl: "https://git.example.com", notified: notified
        ? { "https://git.example.com|team/app|10|build": 1 } : {} }),
      session: storage(), onChanged: event,
    },
    tabs: { query: async () => tabs, onUpdated: event, onRemoved: event },
    runtime: { onInstalled: event, onStartup: event, onMessage: event },
    alarms: { onAlarm: event },
  };
  const context = vm.createContext({
    chrome, URL, console, Date,
    apiRoot: base => `${base}/api/v4/`,
    getMergeRequest: async () => ({ head_pipeline: { id: state.pipeline } }),
    getLatestMrPipeline: async () => null,
    listPipelineJobs: async () => state.jobs,
    getBuildImages: async (...args) => {
      calls.reads += 1;
      return args[3].filter(j => j.status === "success").map(j => ({ image, jobId: j.id }));
    },
    showMrBuildImages: async (tabs, build) => calls.displays.push({ tabs, build }),
    deliverCiNotification: async (...args) => calls.notices.push(args),
    reconcileStalePromoteSession: async () => {},
  });
  vm.runInContext(background, context);
  return { calls, state, poll: () => vm.runInContext("runPoll()", context) };
}

test("already-notified MR still displays the image without another notification", async () => {
  const h = harness({ notified: true });
  await h.poll();
  assert.equal(h.calls.displays[0].build.images[0].image, image);
  assert.equal(h.calls.notices.length, 0);
});

test("opening an old successful MR displays its image without a fresh notification", async () => {
  const h = harness();
  await h.poll();
  assert.equal(h.calls.reads, 1);
  assert.equal(h.calls.notices.length, 0);
});

test("new pipeline or retry clears the previous image, then displays the completed build", async () => {
  const h = harness({ notified: true });
  await h.poll();
  h.state.pipeline = 11;
  h.state.jobs = [{ ...job, id: 43, status: "running" }];
  await h.poll();
  assert.equal(h.calls.displays.at(-1).build.images.length, 0);
  h.state.jobs = [{ ...job, id: 43 }];
  await h.poll();
  assert.equal(h.calls.displays.at(-1).build.images[0].jobId, 43);
  assert.equal(h.calls.notices.length, 1);
  h.state.jobs = [{ ...job, id: 44, status: "pending" }];
  await h.poll();
  assert.equal(h.calls.displays.at(-1).build.images.length, 0);
});

test("failed, skipped-only and incomplete stages never display a ready image", async () => {
  for (const status of ["failed", "skipped", "running", "manual"]) {
    const h = harness({ jobs: [{ ...job, status }] });
    await h.poll();
    assert.equal(h.calls.displays.at(-1).build.images.length, 0);
  }
});

test("MR tabs share reads; pipeline tabs receive no build panel", async () => {
  const h = harness({ tabs: [tab, { ...tab, id: 2 }, {
    id: 3, url: "https://git.example.com/team/app/-/pipelines/10",
  }] });
  await h.poll();
  assert.equal(h.calls.reads, 1);
  assert.deepEqual(Array.from(h.calls.displays[0].tabs, t => t.id), [1, 2]);
});

test("missing pipeline removes an existing panel", async () => {
  const h = harness();
  h.state.pipeline = null;
  await h.poll();
  assert.equal(h.calls.displays[0].build, null);
});

test("trace extraction handles ANSI, caches by job and retries unavailable logs", async () => {
  const originalFetch = globalThis.fetch;
  const originalChrome = globalThis.chrome;
  globalThis.chrome = { storage: { session: storage() } };
  let reads = 0;
  let unavailable = true;
  globalThis.fetch = async url => {
    if (url.includes("/artifacts/")) return new Response("", { status: 404 });
    reads += 1;
    if (unavailable) return new Response("", { status: 403 });
    return new Response(`\u001b[32mUntagged: ${image}\u001b[0m\r`);
  };
  try {
    const args = ["https://git.example.com/api/v4/", "", "team/app", [job]];
    assert.deepEqual(await getBuildImages(...args), []);
    unavailable = false;
    assert.equal((await getBuildImages(...args))[0].image, image);
    assert.equal((await getBuildImages(...args))[0].image, image);
    assert.equal(reads, 2);
    await getBuildImages(...args.slice(0, 3), [{ ...job, id: 43 }]);
    assert.equal(reads, 3);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.chrome = originalChrome;
  }
});

test("artifact image is preferred and skipped jobs are not read", async () => {
  const originalFetch = globalThis.fetch;
  const originalChrome = globalThis.chrome;
  globalThis.chrome = { storage: { session: storage() } };
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(url);
    return new Response(`BUILD_IMAGE_TAG=${image}\n`);
  };
  try {
    const result = await getBuildImages("https://git.example.com/api/v4/", "", "team/app", [
      job, { ...job, id: 43, status: "skipped" },
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].image, image);
    assert.equal(urls.length, 1);
    assert.match(urls[0], /\/artifacts\/images.txt$/);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.chrome = originalChrome;
  }
});
