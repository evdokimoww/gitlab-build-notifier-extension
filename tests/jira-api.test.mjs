import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { checkGitlabAuth, checkJiraAuth, createJiraResolver, normalizeJiraUrls } from "../jira-api.js";

test("default installation declares access to the three configured services", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.host_permissions, [
    "https://git-02.t1-group.ru/*", "https://tasks.t1-group.ru/*", "https://jira.t1-group.ru/*",
  ]);
});

const urls = ["https://tasks.example.com", "https://jira.example.com"];
const key = "RNISSO26-394";
const issue = { id: "123", key, fields: { summary: "Issue" } };
const json = (data, code = 200) => new Response(JSON.stringify(data), {
  status: code, headers: { "content-type": "application/json; charset=utf-8" },
});

function mock(t, handler, allowed = true) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return handler(url, options);
  });
  const previous = globalThis.chrome;
  globalThis.chrome = { permissions: { contains: async () => allowed } };
  t.after(() => { globalThis.chrome = previous; });
  return calls;
}

test("probe both Jira servers using browser sessions and no GitLab token", async t => {
  const calls = mock(t, url => url.startsWith(urls[0]) ? json(issue) : json({}, 404));
  const result = await createJiraResolver().resolve(key, urls);
  assert.deepEqual(result.sites.map(site => site.state), ["found", "not-found"]);
  assert.equal(result.sites[0].url, `${urls[0]}/browse/${key}`);
  assert.equal(calls.length, 2);
  for (const { url, options } of calls) {
    assert.ok(url.endsWith(`/rest/api/2/issue/${key}?fields=summary`));
    assert.equal(options.credentials, "include");
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers["PRIVATE-TOKEN"], undefined);
    assert.ok(options.signal instanceof AbortSignal);
  }
});

test("concurrent requests for one key share both probes and their cache", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = mock(t, async () => { await gate; return json(issue); });
  const resolver = createJiraResolver();
  const first = resolver.resolve(key, urls);
  const second = resolver.resolve(key, urls);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  release();
  assert.deepEqual(await first, await second);
  assert.deepEqual((await resolver.resolve(key, urls)).sites.map(site => site.state), ["found", "found"]);
  assert.equal(calls.length, 2);
  await resolver.resolve(key, urls, true);
  assert.equal(calls.length, 4);
  resolver.clear();
  await resolver.resolve(key, urls);
  assert.equal(calls.length, 6);
});

test("HTML login, unauthorized and SSO redirects never confirm an issue", async t => {
  const responses = [
    () => new Response("<html>Login</html>", { headers: { "content-type": "text/html" } }),
    () => json({}, 401),
    () => ({ type: "opaqueredirect", status: 0 }),
    () => new Response(null, { status: 302, headers: { location: "https://sso.example.com" } }),
  ];
  let response;
  mock(t, () => response());
  for (response of responses) {
    const result = await createJiraResolver().resolve(key, urls);
    assert.deepEqual(result.sites.map(site => site.state), ["login", "login"]);
    assert.ok(result.expires - Date.now() <= 15000, "auth failures must be retried soon");
  }
});

test("missing host permission makes no network requests", async t => {
  const calls = mock(t, () => { throw new Error("must not fetch"); }, false);
  const result = await createJiraResolver().resolve(key, urls);
  assert.deepEqual(result.sites.map(site => site.state), ["permission", "permission"]);
  assert.equal(calls.length, 0);
});

test("unavailable, forbidden, malformed and mismatched issue responses are distinct", async t => {
  let response;
  mock(t, () => response());
  const cases = [
    [() => { throw new TypeError("offline"); }, "unavailable"],
    [() => json({}, 503), "unavailable"],
    [() => json({}, 403), "forbidden"],
    [() => json({ id: "321", key: "OTHER-1" }), "invalid-response"],
    [() => new Response("{", { headers: { "content-type": "application/json" } }), "invalid-response"],
  ];
  for (const [makeResponse, expected] of cases) {
    response = makeResponse;
    const result = await createJiraResolver().resolve(key, urls);
    assert.deepEqual(result.sites.map(site => site.state), [expected, expected]);
  }
});

test("check GitLab token rather than accepting a browser session as proof", async t => {
  const calls = mock(t, () => json({ id: 1, username: "developer" }));
  assert.equal((await checkGitlabAuth("https://git.example.com", "")).state, "no-token");
  assert.equal(calls.length, 0);
  const result = await checkGitlabAuth("https://git.example.com", " secret ");
  assert.equal(result.state, "connected");
  assert.equal(result.name, "developer");
  assert.equal(calls[0].url, "https://git.example.com/api/v4/user");
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.headers["PRIVATE-TOKEN"], "secret");
});

test("expired GitLab token is visible separately from a missing token", async t => {
  mock(t, () => json({}, 401));
  assert.equal((await checkGitlabAuth("https://git.example.com", "expired")).state, "invalid-token");
});

test("Jira authorization checks the current user", async t => {
  const calls = mock(t, () => json({ name: "developer", displayName: "Разработчик" }));
  const result = await checkJiraAuth(urls[0]);
  assert.equal(result.name, "Разработчик");
  assert.equal(result.state, "connected");
  assert.equal(calls[0].url, `${urls[0]}/rest/api/2/myself`);
});

test("normalize context paths and reject credentials, duplicate servers and invalid keys", async () => {
  assert.deepEqual(normalizeJiraUrls([`${urls[0]}/jira/`, urls[1]]), [`${urls[0]}/jira`, urls[1]]);
  assert.throws(() => normalizeJiraUrls([urls[0], `${urls[0]}/`]), /два разных/);
  for (const invalid of ["javascript:alert(1)", "https://user:pass@example.com", "https://example.com?token=x"]) {
    assert.throws(() => normalizeJiraUrls([invalid, urls[1]]));
  }
  await assert.rejects(createJiraResolver().resolve("../myself", urls), /Некорректный ключ/);
});
