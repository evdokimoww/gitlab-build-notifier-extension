/**
 * GitLab REST v4 helpers (service worker context).
 */

/** @param {string} baseUrl e.g. https://git.example.com */
export function apiRoot(baseUrl) {
  return new URL("/api/v4/", baseUrl.replace(/\/$/, "") + "/").toString();
}

async function gitlabFetch(url, token) {
  const headers = { Accept: "application/json" };
  if (token) headers["PRIVATE-TOKEN"] = token;
  const res = await fetch(url, { headers });
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

/**
 * @returns {Promise<{ id: number }|null>}
 */
export async function getMergeRequest(apiBase, token, projectPath, mrIid) {
  const pid = encodeURIComponent(projectPath);
  const url = `${apiBase}projects/${pid}/merge_requests/${mrIid}`;
  return gitlabFetch(url, token);
}

/**
 * @returns {Promise<{ id: number }|null>}
 */
export async function getLatestMrPipeline(apiBase, token, projectPath, mrIid) {
  const pid = encodeURIComponent(projectPath);
  const url = `${apiBase}projects/${pid}/merge_requests/${mrIid}/pipelines?per_page=1&order_by=id&sort=desc`;
  const rows = await gitlabFetch(url, token);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/**
 * Один джоб (для URL вида …/-/jobs/:id — в ответе есть pipeline.id).
 * @returns {Promise<Record<string, unknown>|null>}
 */
export async function getPipelineJob(apiBase, token, projectPath, jobId) {
  const pid = encodeURIComponent(projectPath);
  const url = `${apiBase}projects/${pid}/jobs/${jobId}`;
  return gitlabFetch(url, token);
}

/**
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function listPipelineJobs(apiBase, token, projectPath, pipelineId) {
  const pid = encodeURIComponent(projectPath);
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
