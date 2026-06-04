/**
 * GitLab REST v4 helpers (service worker context).
 */

/** @param {string} baseUrl e.g. https://git.example.com */
export function apiRoot(baseUrl) {
  return new URL("/api/v4/", baseUrl.replace(/\/$/, "") + "/").toString();
}

/**
 * @param {string} url
 * @param {string} token
 * @param {{ method?: string, body?: unknown }} [options]
 */
async function gitlabFetch(url, token, options = {}) {
  const { method = "GET", body } = options;
  const headers = { Accept: "application/json" };
  if (token) headers["PRIVATE-TOKEN"] = token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && body.message
        ? JSON.stringify(body.message)
        : text || res.statusText;
    throw new Error(`GitLab ${res.status}: ${msg}`);
  }
  return body;
}

/** @param {string} projectPath */
export function encodeProjectPath(projectPath) {
  return encodeURIComponent(projectPath);
}

/**
 * @returns {Promise<string>}
 */
export async function gitlabFetchText(url, token) {
  const headers = { Accept: "text/plain, */*" };
  if (token) headers["PRIVATE-TOKEN"] = token;
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GitLab ${res.status}: ${text || res.statusText}`);
  }
  return text;
}

/**
 * @returns {Promise<string|null>}
 */
export async function gitlabFetchTextOrNull(url, token, { notFoundOk = false } = {}) {
  const headers = { Accept: "text/plain, */*" };
  if (token) headers["PRIVATE-TOKEN"] = token;
  const res = await fetch(url, { headers });
  if (notFoundOk && res.status === 404) return null;
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GitLab ${res.status}: ${text || res.statusText}`);
  }
  return text;
}

/**
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getMergeRequest(apiBase, token, projectPath, mrIid) {
  const pid = encodeProjectPath(projectPath);
  const url = `${apiBase}projects/${pid}/merge_requests/${mrIid}`;
  return gitlabFetch(url, token);
}

/**
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function listOpenMergeRequests(
  apiBase,
  token,
  projectPath,
  { sourceBranch, targetBranch }
) {
  const pid = encodeProjectPath(projectPath);
  const q = new URLSearchParams({
    state: "opened",
    source_branch: sourceBranch,
    target_branch: targetBranch,
  });
  const url = `${apiBase}projects/${pid}/merge_requests?${q}`;
  const rows = await gitlabFetch(url, token);
  return Array.isArray(rows) ? rows : [];
}

/**
 * @returns {Promise<Record<string, unknown>>}
 */
export async function createMergeRequest(
  apiBase,
  token,
  projectPath,
  { sourceBranch, targetBranch, title }
) {
  const pid = encodeProjectPath(projectPath);
  const url = `${apiBase}projects/${pid}/merge_requests`;
  return gitlabFetch(url, token, {
    method: "POST",
    body: {
      source_branch: sourceBranch,
      target_branch: targetBranch,
      title,
      remove_source_branch: false,
    },
  });
}

/**
 * @returns {Promise<Record<string, unknown>>}
 */
export async function mergeMergeRequest(apiBase, token, projectPath, mrIid) {
  const pid = encodeProjectPath(projectPath);
  const url = `${apiBase}projects/${pid}/merge_requests/${mrIid}/merge`;
  return gitlabFetch(url, token, {
    method: "PUT",
    body: {
      should_remove_source_branch: false,
      merge_when_pipeline_succeeds: false,
    },
  });
}

/**
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function listMrPipelines(apiBase, token, projectPath, mrIid) {
  const pid = encodeProjectPath(projectPath);
  const url = `${apiBase}projects/${pid}/merge_requests/${mrIid}/pipelines`;
  const rows = await gitlabFetch(url, token);
  return Array.isArray(rows) ? rows : [];
}

/**
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function listPipelinesForRef(
  apiBase,
  token,
  projectPath,
  ref,
  { perPage = 5 } = {}
) {
  const pid = encodeProjectPath(projectPath);
  const q = new URLSearchParams({
    ref,
    order_by: "id",
    sort: "desc",
    per_page: String(perPage),
  });
  const url = `${apiBase}projects/${pid}/pipelines?${q}`;
  const rows = await gitlabFetch(url, token);
  return Array.isArray(rows) ? rows : [];
}

/**
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getProject(apiBase, token, projectPath) {
  const pid = encodeProjectPath(projectPath);
  const url = `${apiBase}projects/${pid}`;
  return gitlabFetch(url, token);
}

/**
 * @returns {Promise<boolean>}
 */
export async function branchExists(apiBase, token, projectPath, branch) {
  const pid = encodeProjectPath(projectPath);
  const branchEnc = encodeURIComponent(branch);
  const url = `${apiBase}projects/${pid}/repository/branches/${branchEnc}`;
  const headers = { Accept: "application/json" };
  if (token) headers["PRIVATE-TOKEN"] = token;
  const res = await fetch(url, { headers });
  if (res.status === 404) return false;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitLab ${res.status}: ${text || res.statusText}`);
  }
  return true;
}

/**
 * @returns {Promise<string>}
 */
export async function getJobTrace(apiBase, token, projectPath, jobId) {
  const pid = encodeProjectPath(projectPath);
  const url = `${apiBase}projects/${pid}/jobs/${jobId}/trace`;
  return gitlabFetchText(url, token);
}

/**
 * @returns {Promise<string|null>}
 */
export async function getJobArtifact(apiBase, token, projectPath, jobId, artifactPath) {
  const pid = encodeProjectPath(projectPath);
  const pathEnc = artifactPath
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
  const url = `${apiBase}projects/${pid}/jobs/${jobId}/artifacts/${pathEnc}`;
  return gitlabFetchTextOrNull(url, token, { notFoundOk: true });
}

/**
 * @returns {Promise<{ id: number }|null>}
 */
export async function getLatestMrPipeline(apiBase, token, projectPath, mrIid) {
  const pid = encodeProjectPath(projectPath);
  const url = `${apiBase}projects/${pid}/merge_requests/${mrIid}/pipelines?per_page=1&order_by=id&sort=desc`;
  const rows = await gitlabFetch(url, token);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/**
 * Один джоб (для URL вида …/-/jobs/:id — в ответе есть pipeline.id).
 * @returns {Promise<Record<string, unknown>|null>}
 */
export async function getPipelineJob(apiBase, token, projectPath, jobId) {
  const pid = encodeProjectPath(projectPath);
  const url = `${apiBase}projects/${pid}/jobs/${jobId}`;
  return gitlabFetch(url, token);
}

/**
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function listPipelineJobs(apiBase, token, projectPath, pipelineId) {
  const pid = encodeProjectPath(projectPath);
  const all = [];
  let page = 1;
  const perPage = 100;
  for (;;) {
    const url = `${apiBase}projects/${pid}/pipelines/${pipelineId}/jobs?per_page=${perPage}&page=${page}`;
    const chunk = await gitlabFetch(url, token);
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    all.push(...chunk);
    if (chunk.length < perPage) break;
    page += 1;
  }
  return all;
}
