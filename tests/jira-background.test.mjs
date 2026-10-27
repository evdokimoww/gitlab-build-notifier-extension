import assert from "node:assert/strict";
import test from "node:test";
import { initializeJiraLinks } from "../jira-background.js";

const gitlab = "https://git.example.com";
const tab = { id: 1, windowId: 12, index: 3, url: `${gitlab}/team/app/-/merge_requests/7`, status: "complete" };
const urls = ["https://tasks.example.com", "https://jira.example.com"];
const settle = () => new Promise(resolve => setImmediate(resolve));

function event() {
  const listeners = [];
  return { addListener(fn) { listeners.push(fn); }, fire(...args) { return listeners.map(fn => fn(...args)); } };
}

function harness(t) {
  const config = { gitlabBaseUrl: gitlab, privateToken: "", jiraBaseUrls: urls };
  const calls = [];
  const opened = [];
  const updated = event();
  const changed = event();
  const message = event();
  const previous = globalThis.chrome;
  globalThis.chrome = {
    storage: { local: { get: async defaults => ({ ...defaults, ...config }) }, onChanged: changed },
    tabs: { query: async () => [tab, { id: 2, url: "https://other.example.com/" }], onUpdated: updated,
      create: async options => { opened.push(options); return { id: opened.length + 10 }; } },
    permissions: { contains: async () => true, onAdded: event(), onRemoved: event() },
    scripting: { executeScript: async value => { calls.push(value); } },
    runtime: { onMessage: message, onInstalled: event(), onStartup: event() },
  };
  t.after(() => { globalThis.chrome = previous; });
  initializeJiraLinks();
  return { config, calls, opened, updated, changed,
    send(value, sender = { tab, url: tab.url }) {
      return new Promise(resolve => message.fire(value, sender, resolve));
    },
  };
}

test("inject on the configured GitLab even without a token", async t => {
  const h = harness(t);
  await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].target.tabId, 1);
  assert.deepEqual(h.calls[0].args, [{ enabled: true, baseUrls: urls }]);
  h.updated.fire(tab.id, { status: "complete" }, tab);
  await settle();
  assert.equal(h.calls.length, 2);
});

test("a key confirmed in both Jira servers opens exactly two tabs in the source window", async t => {
  const h = harness(t);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ id: "1", key: "RNISSO26-394" }), {
    headers: { "content-type": "application/json" },
  }));
  const response = await h.send({ type: "jira-open", key: "RNISSO26-394",
    sourceUrl: `${urls[1]}/browse/RNISSO26-394?atlogin=test-only-source-token&focusedCommentId=12631#comment-12631` });
  assert.equal(response.ok, true);
  assert.equal(h.opened.length, 2);
  assert.deepEqual(h.opened.map(value => value.active), [true, false]);
  assert.deepEqual(h.opened.map(value => value.index), [4, 5]);
  for (const opened of h.opened) {
    assert.equal(opened.windowId, tab.windowId);
    assert.equal(opened.openerTabId, tab.id);
    const url = new URL(opened.url);
    assert.equal(url.searchParams.get("focusedCommentId"), "12631");
    assert.equal(url.hash, "#comment-12631");
  }
  assert.equal(new URL(h.opened[0].url).origin, urls[0]);
  assert.equal(new URL(h.opened[0].url).searchParams.has("atlogin"), false);
  assert.equal(new URL(h.opened[1].url).origin, urls[1]);
  assert.equal(new URL(h.opened[1].url).searchParams.has("atlogin"), true);
  await h.send({ type: "jira-open", key: "RNISSO26-394", sourceUrl: `${urls[1]}/browse/RNISSO26-394`, background: true });
  assert.deepEqual(h.opened.slice(2).map(value => value.active), [false, false]);
  await settle();
});

test("opening tasks rejects unknown source URLs and opens only confirmed destinations", async t => {
  const h = harness(t);
  t.mock.method(globalThis, "fetch", async url => new Response(
    JSON.stringify({ id: "1", key: "RNISSO26-394" }), {
      status: url.startsWith(urls[0]) ? 200 : 404, headers: { "content-type": "application/json" },
    },
  ));
  for (const sourceUrl of ["https://other.example.com/browse/RNISSO26-394", `${urls[0]}/browse/OTHER-1`]) {
    assert.equal((await h.send({ type: "jira-open", key: "RNISSO26-394", sourceUrl })).ok, false);
  }
  assert.equal(h.opened.length, 0);
  const response = await h.send({ type: "jira-open", key: "RNISSO26-394", sourceUrl: `${urls[0]}/browse/RNISSO26-394` });
  assert.equal(response.ok, true);
  assert.equal(h.opened.length, 1);
  assert.equal(h.opened[0].url, `${urls[0]}/browse/RNISSO26-394`);
  await settle();
});

test("changing GitLab cleans up the previous host and disabling restores links", async t => {
  const h = harness(t);
  await settle();
  h.config.gitlabBaseUrl = "https://new-git.example.com";
  h.changed.fire({ gitlabBaseUrl: { oldValue: gitlab, newValue: h.config.gitlabBaseUrl } }, "local");
  await settle();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].args[0].enabled, false);
  h.config.gitlabBaseUrl = gitlab;
  h.config.enableJiraLinks = false;
  h.changed.fire({ enableJiraLinks: { newValue: false } }, "local");
  await settle();
  assert.equal(h.calls.at(-1).args[0].enabled, false);
});

test("an older permission check cannot restore superseded injection settings", async t => {
  const h = harness(t);
  const permissions = [];
  globalThis.chrome.permissions.contains = () => new Promise(resolve => permissions.push(resolve));
  await settle();
  h.config.enableJiraLinks = false;
  h.changed.fire({ enableJiraLinks: { oldValue: true, newValue: false } }, "local");
  await settle();
  permissions[1](true);
  await settle();
  permissions[0](true);
  await settle();
  // A superseded refresh may re-read current settings instead of executing its old snapshot.
  for (const resolve of permissions.slice(2)) resolve(true);
  await settle();
  assert.ok(h.calls.length > 0);
  assert.ok(h.calls.every(call => call.args[0].enabled === false));
});

test("resolve only from configured GitLab content scripts and invalidate after visiting Jira", async t => {
  const h = harness(t);
  let reads = 0;
  t.mock.method(globalThis, "fetch", async () => {
    reads++;
    return new Response(JSON.stringify({ id: "1", key: "RNISSO26-394" }), {
      headers: { "content-type": "application/json" },
    });
  });
  const request = { type: "jira-resolve", key: "RNISSO26-394" };
  assert.equal((await h.send(request, { tab, url: "https://other.example.com/" })).ok, false);
  assert.equal((await h.send(request, {})).ok, false);
  assert.equal(reads, 0);
  assert.equal((await h.send(request)).result.sites[0].state, "found");
  await h.send(request);
  assert.equal(reads, 2, "cached across repeated content-script requests");
  h.updated.fire(3, { status: "complete" }, { id: 3, url: `${urls[0]}/secure/Dashboard.jspa` });
  await settle();
  await h.send(request);
  assert.equal(reads, 4, "Jira navigation invalidates the cache after a possible login");
  await settle();
});
