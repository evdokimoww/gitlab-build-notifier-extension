import assert from "node:assert/strict";
import test from "node:test";
import { listMrPipelinesForSha, listPipelinesForRef } from "../gitlab-api.js";

const base = "https://git.example.com/api/v4/";

test("MR pipeline lookup verifies merged-result parents and ignores expired or stale results", async t => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const ref = "refs/merge-requests/2/merge";
  const pipelines = [
    { id: 15, sha: "expired", ref }, { id: 14, sha: "old-result", ref },
    { id: 13, sha: "current-result", ref }, { id: 12, sha: "head" },
    { id: 11, sha: "old" },
  ];
  globalThis.fetch = async url => {
    if (url.endsWith("/merge_requests/2/pipelines")) {
      return { ok: true, text: async () => JSON.stringify(pipelines) };
    }
    if (url.endsWith("/commits/expired")) {
      return { ok: false, status: 404, text: async () => "not found" };
    }
    const source = url.endsWith("/commits/current-result") ? "head" : "old";
    return { ok: true, text: async () => JSON.stringify({ parent_ids: ["target", source] }) };
  };
  const current = await listMrPipelinesForSha(base, "token", "team/app", { iid: 2, sha: "head" });
  assert.deepEqual(current.map(p => p.id), [13, 12]);
  assert.equal(current[0].sha, "current-result");
  assert.equal(current[0].source_sha, "head");
});

test("MR pipeline lookup preserves authentication errors", async t => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async url => url.endsWith("/pipelines")
    ? { ok: true, text: async () => JSON.stringify([{ id: 1, sha: "result", ref: "refs/merge-requests/2/merge" }]) }
    : { ok: false, status: 403, text: async () => "forbidden" };
  await assert.rejects(listMrPipelinesForSha(base, "token", "team/app", { iid: 2, sha: "head" }), /GitLab 403/);
});

test("branch pipeline lookup sends the expected SHA to GitLab", async t => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async url => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("sha"), "batch-head");
    assert.equal(parsed.searchParams.get("ref"), "team/master");
    return { ok: true, text: async () => "[]" };
  };
  await listPipelinesForRef(base, "token", "team/app", "team/master", { sha: "batch-head" });
});
