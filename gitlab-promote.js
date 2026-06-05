/**
 * Promote feature MR → develop → production (master/main).
 * Port of gitlab-promote-mr.py for the extension UI.
 */

import {
  apiRoot,
  branchExists,
  createMergeRequest,
  createMrPipeline,
  createRefPipeline,
  getJobArtifact,
  getJobTrace,
  getMergeRequest,
  getProject,
  listMrPipelines,
  listOpenMergeRequests,
  listPipelineJobs,
  listPipelinesForRef,
  mergeMergeRequest,
} from "./gitlab-api.js";

/** Pipeline ещё выполняется или только создаётся. */
const PIPELINE_ACTIVE = new Set([
  "created",
  "pending",
  "running",
  "waiting_for_resource",
  "preparing",
  "scheduled",
  "manual",
  "playing",
  "canceling",
]);

const MR_URL_RE =
  /(?:https?:\/\/)?[^/]+\/(?<project>.+?)\/-\/merge_requests\/(?<iid>\d+)/i;
const MR_REF_RE = /^(?<project>.+?)!(?<iid>\d+)$/;
const UNTAGGED_IMAGE_RE = /^Untagged:\s*(.+?)\s*$/gm;
const IMAGE_LINE_RE = /^[^\s:]+:[^\s:]+$/;
const PRODUCTION_SUFFIXES = ["master", "main"];

/**
 * @typedef {{ project: string, iid: number }} MrRef
 * @typedef {(line: string) => void} LogFn
 * @typedef {{ signal?: AbortSignal, log?: LogFn, heartbeat?: () => void, onBuildImage?: (image: string) => void, onConflict?: (mr: Record<string, unknown>, message: string) => void }} PromoteHooks
 */

export class MrMergeConflictError extends Error {
  /**
   * @param {Record<string, unknown>} mr
   * @param {string} message
   */
  constructor(mr, message) {
    super(message);
    this.name = "MrMergeConflictError";
    this.mr = mr;
  }
}

/**
 * @param {string} arg
 * @returns {MrRef}
 */
export function parseMrArg(arg) {
  const trimmed = arg.trim();
  const urlMatch = MR_URL_RE.exec(trimmed);
  if (urlMatch?.groups) {
    return { project: urlMatch.groups.project, iid: Number(urlMatch.groups.iid) };
  }
  const refMatch = MR_REF_RE.exec(trimmed);
  if (refMatch?.groups) {
    return { project: refMatch.groups.project, iid: Number(refMatch.groups.iid) };
  }
  throw new Error(
    `Не удалось разобрать ссылку на MR: ${arg}\n` +
      "Используйте URL, group/project!123 или полный URL merge request."
  );
}

/**
 * @param {string} primary
 * @param {string} [batchText]
 * @returns {MrRef[]}
 */
export function parseMrArgList(primary, batchText) {
  const lines = [];
  if (primary?.trim()) lines.push(primary.trim());
  if (batchText?.trim()) {
    for (const line of batchText.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      lines.push(t);
    }
  }
  if (!lines.length) {
    throw new Error("Укажите хотя бы один merge request");
  }

  const refs = lines.map(parseMrArg);
  const seen = new Set();
  const unique = [];
  for (const ref of refs) {
    const key = `${ref.project}!${ref.iid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
  }
  return unique;
}

/**
 * @param {string} targetBranch
 */
export function requireDevelopTarget(targetBranch) {
  if (!targetBranch.toLowerCase().includes("develop")) {
    throw new Error(
      `Target-ветка ${JSON.stringify(targetBranch)} должна содержать develop (например hmao/develop)`
    );
  }
}

/**
 * @param {string} developBranch
 * @returns {{ prefix: string | null, candidates: string[] }}
 */
export function productionCandidates(developBranch) {
  const parts = developBranch.split("/");
  if (parts.length >= 2 && parts[parts.length - 1].toLowerCase().includes("develop")) {
    const prefix = parts.slice(0, -1).join("/");
    return {
      prefix,
      candidates: PRODUCTION_SUFFIXES.map((s) => `${prefix}/${s}`),
    };
  }
  if (developBranch.toLowerCase() === "develop") {
    return { prefix: null, candidates: [...PRODUCTION_SUFFIXES] };
  }
  throw new Error(
    `Не удалось вывести production-ветку из develop ${JSON.stringify(developBranch)}`
  );
}

/**
 * @param {string} override
 */
function productionSuffixFromOverride(override) {
  const value = override.trim().toLowerCase();
  if (PRODUCTION_SUFFIXES.includes(value)) return value;
  throw new Error(
    `Некорректная production-ветка ${JSON.stringify(override)}; укажите main или master, либо полное имя ветки`
  );
}

/**
 * @param {string | null} prefix
 * @param {string} suffix
 */
function buildProductionBranch(prefix, suffix) {
  return prefix ? `${prefix}/${suffix}` : suffix;
}

function checkAborted(signal) {
  if (signal?.aborted) throw new DOMException("Отменено", "AbortError");
}

/** Периодический лог при долгом ожидании pipeline (мин). */
const WAIT_PROGRESS_LOG_MS = 5 * 60 * 1000;

/**
 * @param {{ heartbeat?: () => void }} ctx
 */
function pulseWait(ctx) {
  ctx.heartbeat?.();
}

/**
 * @param {{ log: LogFn }} ctx
 * @returns {number}
 */
function maybeLogWaitProgress(
  ctx,
  { label, pid, status, waitStartedAt, lastProgressLogAt }
) {
  const now = Date.now();
  if (now - lastProgressLogAt < WAIT_PROGRESS_LOG_MS) return lastProgressLogAt;
  const mins = Math.floor((now - waitStartedAt) / 60000);
  ctx.log(`  ${label} #${pid}: ${status} (${mins} мин ожидания)`);
  return now;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Отменено", "AbortError"));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Отменено", "AbortError"));
      },
      { once: true }
    );
  });
}

/**
 * @param {string} apiBase
 * @param {string} token
 * @param {string} project
 * @param {string} developBranch
 * @param {string | undefined} override
 * @param {AbortSignal} [signal]
 */
export async function resolveProductionBranch(
  apiBase,
  token,
  project,
  developBranch,
  override,
  signal
) {
  const { prefix, candidates } = productionCandidates(developBranch);

  if (override?.trim()) {
    const o = override.trim();
    if (o.includes("/")) {
      checkAborted(signal);
      if (!(await branchExists(apiBase, token, project, o))) {
        throw new Error(`Production-ветка ${JSON.stringify(o)} не найдена в ${project}`);
      }
      return o;
    }
    const suffix = productionSuffixFromOverride(o);
    const branch = buildProductionBranch(prefix, suffix);
    checkAborted(signal);
    if (!(await branchExists(apiBase, token, project, branch))) {
      throw new Error(`Production-ветка ${JSON.stringify(branch)} не найдена в ${project}`);
    }
    return branch;
  }

  checkAborted(signal);
  const existing = [];
  for (const b of candidates) {
    checkAborted(signal);
    if (await branchExists(apiBase, token, project, b)) existing.push(b);
  }

  checkAborted(signal);
  const projectInfo = await getProject(apiBase, token, project);
  const defaultBranch = String(projectInfo.default_branch || "master");

  if (existing.length === 1) return existing[0];

  if (existing.length > 1) {
    if (PRODUCTION_SUFFIXES.includes(defaultBranch)) {
      const preferred = buildProductionBranch(prefix, defaultBranch);
      if (existing.includes(preferred)) return preferred;
    }
    return existing[0];
  }

  if (PRODUCTION_SUFFIXES.includes(defaultBranch)) {
    const fallback = buildProductionBranch(prefix, defaultBranch);
    checkAborted(signal);
    if (await branchExists(apiBase, token, project, fallback)) return fallback;
  }

  throw new Error(
    `Production-ветка для ${JSON.stringify(developBranch)} не найдена в ${project} ` +
      `(пробовали: ${candidates.join(", ")}; default_branch: ${defaultBranch})`
  );
}

/**
 * @param {Record<string, unknown>[]} pipelines
 * @param {number} timeoutSec
 * @param {number} pollSec
 * @param {LogFn} log
 * @param {string} label
 * @param {() => Promise<Record<string, unknown>[]>} fetchPipelines
 * @param {AbortSignal} [signal]
 */
/**
 * @param {Record<string, unknown>} mr
 */
async function ensureMrPipelineStarted(
  apiBase,
  token,
  project,
  mr,
  { dryRun, log, signal }
) {
  if (dryRun) return;

  const iid = Number(mr.iid);
  checkAborted(signal);
  const pipelines = await listMrPipelines(apiBase, token, project, iid);
  if (pipelines.some((p) => PIPELINE_ACTIVE.has(String(p.status)))) return;

  log(`MR !${iid}: pipeline не запущен, запуск…`);
  try {
    const created = await createMrPipeline(apiBase, token, project, iid);
    log(`  создан MR pipeline #${created.id}`);
  } catch (firstErr) {
    const sourceBranch = String(mr.source_branch || "");
    if (!sourceBranch) throw firstErr;
    log(`  запуск pipeline на ветке ${JSON.stringify(sourceBranch)}…`);
    const created = await createRefPipeline(apiBase, token, project, sourceBranch);
    log(`  создан branch pipeline #${created.id}`);
  }
  await sleep(3000, signal);
}

/**
 * @param {number | null} afterPipelineId
 */
async function ensureBranchPipelineStarted(
  apiBase,
  token,
  project,
  ref,
  afterPipelineId,
  { dryRun, log, signal }
) {
  if (dryRun) return;

  checkAborted(signal);
  const pipelines = await listPipelinesForRef(apiBase, token, project, ref, { perPage: 10 });

  const hasRelevantActive = pipelines.some((p) => {
    const pid = Number(p.id);
    if (afterPipelineId != null && pid <= afterPipelineId) return false;
    return PIPELINE_ACTIVE.has(String(p.status));
  });
  if (hasRelevantActive) return;

  const hasNewer = pipelines.some((p) => afterPipelineId == null || Number(p.id) > afterPipelineId);
  if (hasNewer) return;

  log(`Ветка ${JSON.stringify(ref)}: pipeline не запущен, запуск…`);
  const created = await createRefPipeline(apiBase, token, project, ref);
  log(`  создан branch pipeline #${created.id}`);
  await sleep(3000, signal);
}

async function waitPipelineLoop(
  fetchPipelines,
  { timeoutSec, pollSec, log, label, signal, onNoPipeline, heartbeat }
) {
  const ctx = { log, heartbeat };
  const terminalOk = new Set(["success"]);
  const terminalBad = new Set(["failed", "canceled", "skipped"]);
  const deadline = Date.now() + timeoutSec * 1000;
  let seen = null;
  let triedStart = false;
  let waitStartedAt = Date.now();
  let lastProgressLogAt = 0;

  while (Date.now() < deadline) {
    checkAborted(signal);
    pulseWait(ctx);
    const pipelines = await fetchPipelines();
    if (!pipelines.length) {
      if (!triedStart && onNoPipeline) {
        triedStart = true;
        await onNoPipeline();
        continue;
      }
      log(`  ${label}: ожидание первого pipeline…`);
      await sleep(pollSec * 1000, signal);
      continue;
    }
    const latest = pipelines[0];
    const pid = Number(latest.id);
    const status = String(latest.status);
    if (pid !== seen) {
      seen = pid;
      waitStartedAt = Date.now();
      lastProgressLogAt = waitStartedAt;
      log(`  ${label} #${pid}: ${status}`);
    } else {
      lastProgressLogAt = maybeLogWaitProgress(ctx, {
        label,
        pid,
        status,
        waitStartedAt,
        lastProgressLogAt,
      });
    }
    if (terminalOk.has(status)) return pid;
    if (terminalBad.has(status)) {
      throw new Error(`${label} #${pid} завершился со статусом: ${status}`);
    }
    await sleep(pollSec * 1000, signal);
  }
  throw new Error(`${label}: pipeline не успел за ${timeoutSec} с`);
}

/**
 * @param {string} apiBase
 * @param {string} token
 * @param {string} project
 * @param {string} ref
 * @param {number | null} afterPipelineId
 * @param {{ timeoutSec: number, pollSec: number, log: LogFn, signal?: AbortSignal }} opts
 */
async function waitBranchPipeline(
  apiBase,
  token,
  project,
  ref,
  afterPipelineId,
  { timeoutSec, pollSec, log, signal, dryRun, heartbeat }
) {
  const ctx = { log, heartbeat };
  if (!dryRun) {
    await ensureBranchPipelineStarted(apiBase, token, project, ref, afterPipelineId, {
      dryRun,
      log,
      signal,
    });
  }

  const deadline = Date.now() + timeoutSec * 1000;
  let triedStart = false;
  let seenKey = "";
  let waitStartedAt = Date.now();
  let lastProgressLogAt = 0;

  while (Date.now() < deadline) {
    checkAborted(signal);
    pulseWait(ctx);
    const pipelines = await listPipelinesForRef(apiBase, token, project, ref, { perPage: 10 });
    if (!pipelines.length) {
      if (!triedStart && !dryRun) {
        triedStart = true;
        await ensureBranchPipelineStarted(apiBase, token, project, ref, afterPipelineId, {
          dryRun,
          log,
          signal,
        });
        continue;
      }
      log(`  branch pipeline: ожидание pipeline на ${JSON.stringify(ref)}…`);
      await sleep(pollSec * 1000, signal);
      continue;
    }

    let candidate = null;
    for (const pipeline of pipelines) {
      const pid = Number(pipeline.id);
      if (afterPipelineId != null && pid <= afterPipelineId) continue;
      candidate = pipeline;
      break;
    }

    if (!candidate) {
      if (!triedStart && !dryRun) {
        triedStart = true;
        await ensureBranchPipelineStarted(apiBase, token, project, ref, afterPipelineId, {
          dryRun,
          log,
          signal,
        });
        continue;
      }
      log(
        `  branch pipeline: ожидание нового pipeline на ${JSON.stringify(ref)} ` +
          `(после #${afterPipelineId})…`
      );
      await sleep(pollSec * 1000, signal);
      continue;
    }

    const pid = Number(candidate.id);
    const status = String(candidate.status);
    const key = `${pid}:${status}`;
    if (key !== seenKey) {
      seenKey = key;
      waitStartedAt = Date.now();
      lastProgressLogAt = waitStartedAt;
      log(`  branch pipeline #${pid} на ${ref}: ${status}`);
    } else {
      lastProgressLogAt = maybeLogWaitProgress(ctx, {
        label: `branch pipeline ${ref}`,
        pid,
        status,
        waitStartedAt,
        lastProgressLogAt,
      });
    }

    if (status === "success") return pid;
    if (["failed", "canceled", "skipped"].includes(status)) {
      throw new Error(`Branch pipeline #${pid} на ${ref} завершился: ${status}`);
    }

    await sleep(pollSec * 1000, signal);
  }

  throw new Error(
    `Pipeline на ${JSON.stringify(ref)} не успел за ${timeoutSec} с (после #${afterPipelineId})`
  );
}

/**
 * @param {Record<string, unknown>[]} jobs
 * @param {string} stageName
 */
function findBuildJob(jobs, stageName) {
  const stageLower = stageName.toLowerCase();
  const stageMatches = jobs.filter(
    (j) => String(j.stage || "").toLowerCase() === stageLower
  );
  if (stageMatches.length) {
    return stageMatches.reduce((a, b) => (Number(a.id) > Number(b.id) ? a : b));
  }
  const nameMatches = jobs.filter((j) =>
    String(j.name || "")
      .toLowerCase()
      .includes(stageLower)
  );
  if (nameMatches.length) {
    return nameMatches.reduce((a, b) => (Number(a.id) > Number(b.id) ? a : b));
  }
  const stages = [...new Set(jobs.map((j) => String(j.stage || "")))].sort().join(", ");
  throw new Error(
    `CI job для стадии ${JSON.stringify(stageName)} не найден. Доступные stage: ${stages}`
  );
}

/**
 * @param {string} content
 */
function parseImageFromArtifacts(content) {
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    if (t.startsWith("BUILD_IMAGE_TAG=")) return t.split("=", 2)[1].trim();
    if (IMAGE_LINE_RE.test(t)) return t;
  }
  return null;
}

/**
 * @param {string} trace
 */
function parseImageFromTrace(trace) {
  const matches = [...trace.matchAll(UNTAGGED_IMAGE_RE)];
  if (matches.length) return matches[matches.length - 1][1].trim();
  return null;
}

/**
 * @param {string} apiBase
 * @param {string} token
 * @param {string} project
 * @param {number} pipelineId
 * @param {string} stageName
 * @param {LogFn} log
 * @param {AbortSignal} [signal]
 */
export async function extractBuildImage(
  apiBase,
  token,
  project,
  pipelineId,
  stageName,
  log,
  signal
) {
  checkAborted(signal);
  const jobs = await listPipelineJobs(apiBase, token, project, pipelineId);
  const buildJob = findBuildJob(jobs, stageName);
  const jobId = Number(buildJob.id);
  const jobName = buildJob.name || buildJob.stage;
  log(`Чтение образа из job #${jobId} (${jobName}, stage=${buildJob.stage})`);

  for (const artifactPath of ["images.txt", "build.env"]) {
    checkAborted(signal);
    const content = await getJobArtifact(apiBase, token, project, jobId, artifactPath);
    if (content) {
      const image = parseImageFromArtifacts(content);
      if (image) {
        log(`  найден в артефакте ${artifactPath}`);
        return image;
      }
    }
  }

  checkAborted(signal);
  const trace = await getJobTrace(apiBase, token, project, jobId);
  const image = parseImageFromTrace(trace);
  if (image) {
    log("  найден в логе (Untagged:)");
    return image;
  }

  throw new Error(
    `Образ не найден в job #${jobId} (проверены images.txt, build.env и Untagged: в логе)`
  );
}

/**
 * @param {Record<string, unknown>} mr
 */
export function mrHasConflict(mr) {
  if (mr.has_conflicts === true) return true;
  const detailed = String(mr.detailed_merge_status || "");
  if (detailed === "conflict" || detailed === "cannot_be_merged") return true;
  const mergeStatus = String(mr.merge_status || "");
  return mergeStatus === "cannot_be_merged" || mergeStatus === "broken";
}

/**
 * @param {string} apiBase
 * @param {string} token
 * @param {string} project
 * @param {number} iid
 * @param {AbortSignal} [signal]
 */
async function refreshMergeRequest(apiBase, token, project, iid, signal) {
  checkAborted(signal);
  return getMergeRequest(apiBase, token, project, iid);
}

/**
 * @param {Record<string, unknown>} mr
 * @param {string} label
 * @param {PromoteHooks} [hooks]
 */
function throwIfConflict(mr, label, hooks) {
  if (!mrHasConflict(mr)) return;
  const target = String(mr.target_branch || "");
  const msg =
    `${label} MR !${mr.iid}: конфликт при слиянии в ${target}` +
    (mr.web_url ? ` — ${mr.web_url}` : "");
  hooks?.onConflict?.(mr, msg);
  throw new MrMergeConflictError(mr, msg);
}

/**
 * @param {Record<string, unknown>} mr
 * @param {string} label
 * @param {PromoteHooks} [hooks]
 */
function ensureMergeable(mr, label, hooks) {
  const state = String(mr.state);
  if (state === "merged") return;
  if (state !== "opened") {
    throw new Error(`${label} MR !${mr.iid} в состоянии ${state}, ожидался opened/merged`);
  }
  throwIfConflict(mr, label, hooks);
  const mergeStatus = mr.merge_status || mr.detailed_merge_status;
  if (mergeStatus === "checking") {
    return;
  }
  if (mergeStatus === "cannot_be_merged" || mergeStatus === "broken") {
    throwIfConflict(mr, label, hooks);
    throw new Error(`${label} MR !${mr.iid} нельзя смержить (status: ${mergeStatus})`);
  }
}

/**
 * @param {string} apiBase
 * @param {string} token
 * @param {MrRef[]} refs
 * @param {AbortSignal} [signal]
 */
async function loadAndValidateBatch(apiBase, token, refs, signal) {
  const mrs = [];
  for (const ref of refs) {
    checkAborted(signal);
    const mr = await getMergeRequest(apiBase, token, ref.project, ref.iid);
    requireDevelopTarget(String(mr.target_branch));
    mrs.push({ ref, mr });
  }

  const project = refs[0].project;
  const developBranch = String(mrs[0].mr.target_branch);

  for (let i = 1; i < mrs.length; i++) {
    if (refs[i].project !== project) {
      throw new Error(
        `MR !${refs[i].iid} в проекте ${refs[i].project}, ожидался ${project}`
      );
    }
    const target = String(mrs[i].mr.target_branch);
    if (target !== developBranch) {
      throw new Error(
        `MR !${refs[i].iid} target ${target} ≠ ${developBranch} — все MR должны идти в одну develop-ветку`
      );
    }
  }

  return { project, developBranch, mrs };
}

/**
 * @typedef {Object} PromoteOptions
 * @property {string} mrArg
 * @property {string} [mrBatch]
 * @property {boolean} [dryRun]
 * @property {boolean} [waitFeaturePipeline]
 * @property {boolean} [stopAfterFeature]
 * @property {boolean} [stopAfterPromoteMr]
 * @property {number} [pipelineTimeoutSec]
 * @property {number} [pollIntervalSec]
 * @property {string} [productionBranch]
 * @property {string} [buildStage]
 * @property {boolean} [skipBuildImage]
 */

/**
 * @param {string} apiBaseUrl
 * @param {string} token
 * @param {PromoteOptions} options
 * @param {PromoteHooks} [hooks]
 * @returns {Promise<{ buildImage?: string }>}
 */
export async function runPromote(apiBaseUrl, token, options, hooks = {}) {
  const log = hooks.log || (() => {});
  const heartbeat = hooks.heartbeat || (() => {});
  const signal = hooks.signal;

  if (!token?.trim()) {
    throw new Error("Укажите Personal Access Token в настройках (нужен scope api)");
  }

  const refs = parseMrArgList(options.mrArg, options.mrBatch);
  const apiBase = apiRoot(apiBaseUrl);
  const dryRun = Boolean(options.dryRun);
  const pipelineTimeout = options.pipelineTimeoutSec ?? 7200;
  const pollSec = options.pollIntervalSec ?? 20;
  const buildStage = (options.buildStage || "build").trim();

  log(`Проект: ${refs[0].project}`);
  if (refs.length === 1) {
    log(`Feature MR: !${refs[0].iid}`);
  } else {
    log(`Feature MR (${refs.length}): ${refs.map((r) => `!${r.iid}`).join(", ")}`);
  }

  checkAborted(signal);
  const batch = await loadAndValidateBatch(apiBase, token, refs, signal);
  const { project, developBranch, mrs } = batch;
  let featureMr = mrs[mrs.length - 1].mr;

  let productionBranch;
  const productionOverride = options.productionBranch?.trim() || "";
  if (dryRun && !productionOverride) {
    const { candidates } = productionCandidates(developBranch);
    productionBranch = candidates[0];
    log(
      `Dry run: production не проверяется через API; предполагаем ${JSON.stringify(productionBranch)}`
    );
  } else {
    productionBranch = await resolveProductionBranch(
      apiBase,
      token,
      project,
      developBranch,
      productionOverride || undefined,
      signal
    );
  }

  log(`Develop:    ${developBranch}`);
  log(`Production: ${productionBranch}`);
  if (dryRun) log("--- dry run ---");

  for (let i = 0; i < mrs.length; i++) {
    const { ref: mrRef, mr: initialMr } = mrs[i];
    const label =
      mrs.length > 1 ? `Feature ${i + 1}/${mrs.length}` : "Feature";

    checkAborted(signal);
    let mr = await refreshMergeRequest(apiBase, token, project, mrRef.iid, signal);
    throwIfConflict(mr, label, hooks);
    ensureMergeable(mr, label, hooks);

    mr = await mergeIfNeeded(apiBase, token, project, mr, {
      dryRun,
      label,
      waitPipelineBefore: Boolean(options.waitFeaturePipeline),
      pipelineTimeout,
      pollSec,
      log,
      heartbeat,
      signal,
      hooks,
    });

    if (!dryRun && String(mr.state) !== "merged") {
      checkAborted(signal);
      mr = await refreshMergeRequest(apiBase, token, project, mrRef.iid, signal);
    }
    if (mr.web_url) log(`${label}: ${mr.web_url}`);
    featureMr = mr;
  }

  if (options.stopAfterFeature) {
    log("Остановка после merge feature → develop.");
    return {};
  }

  let promoteMr = await getOrCreatePromoteMr(apiBase, token, project, {
    developBranch,
    productionBranch,
    dryRun,
    log,
    signal,
  });

  if (!dryRun) {
    checkAborted(signal);
    promoteMr = await getMergeRequest(apiBase, token, project, Number(promoteMr.iid));
  }
  log(`Promote MR: !${promoteMr.iid} (${promoteMr.web_url || ""})`);

  if (options.stopAfterPromoteMr) {
    log("Остановка после создания promote MR.");
    return {};
  }

  let lastPipelineBeforeMerge = null;
  if (!dryRun) {
    checkAborted(signal);
    const pipelines = await listPipelinesForRef(apiBase, token, project, productionBranch, {
      perPage: 1,
    });
    if (pipelines.length) lastPipelineBeforeMerge = Number(pipelines[0].id);

    log("Ожидание pipeline promote MR…");
    await ensureMrPipelineStarted(apiBase, token, project, promoteMr, {
      dryRun,
      log,
      signal,
    });
    await waitPipelineLoop(
      () => listMrPipelines(apiBase, token, project, Number(promoteMr.iid)),
      {
        timeoutSec: pipelineTimeout,
        pollSec,
        log,
        heartbeat,
        label: `MR pipeline !${promoteMr.iid}`,
        signal,
        onNoPipeline: () =>
          ensureMrPipelineStarted(apiBase, token, project, promoteMr, {
            dryRun,
            log,
            signal,
          }),
      }
    );
  }

  promoteMr = await mergeIfNeeded(apiBase, token, project, promoteMr, {
    dryRun,
    label: "Promote",
    waitPipelineBefore: false,
    pipelineTimeout,
    pollSec,
    log,
    heartbeat,
    signal,
    hooks,
  });

  if (!dryRun) {
    checkAborted(signal);
    promoteMr = await getMergeRequest(apiBase, token, project, Number(promoteMr.iid));
  }

  let buildImage;
  if (!dryRun && !options.skipBuildImage) {
    log(`Ожидание build pipeline на ${JSON.stringify(productionBranch)}…`);
    const productionPipelineId = await waitBranchPipeline(
      apiBase,
      token,
      project,
      productionBranch,
      lastPipelineBeforeMerge,
      { timeoutSec: pipelineTimeout, pollSec, log, heartbeat, signal, dryRun }
    );
    buildImage = await extractBuildImage(
      apiBase,
      token,
      project,
      productionPipelineId,
      buildStage,
      log,
      signal
    );
  }

  log("Готово.");
  log(
    `  Ветка ${JSON.stringify(developBranch)} не удалялась (should_remove_source_branch=false).`
  );
  log(`  Promote MR: ${promoteMr.state}`);
  if (buildImage) {
    log(`Build image: ${buildImage}`);
    hooks.onBuildImage?.(buildImage);
  }

  return { buildImage };
}

/**
 * @param {Record<string, unknown>} mr
 */
async function mergeIfNeeded(
  apiBase,
  token,
  project,
  mr,
  { dryRun, label, waitPipelineBefore, pipelineTimeout, pollSec, log, heartbeat, signal, hooks }
) {
  const iid = Number(mr.iid);
  if (String(mr.state) === "merged") {
    log(`${label}: уже смержен (!${iid})`);
    return mr;
  }

  if (!dryRun) {
    mr = await refreshMergeRequest(apiBase, token, project, iid, signal);
  }
  ensureMergeable(mr, label, hooks);

  if (waitPipelineBefore) {
    log(`${label}: ожидание pipeline перед merge (!${iid})…`);
    if (!dryRun) {
      await ensureMrPipelineStarted(apiBase, token, project, mr, { dryRun, log, signal });
      await waitPipelineLoop(
        () => listMrPipelines(apiBase, token, project, iid),
        {
          timeoutSec: pipelineTimeout,
          pollSec,
          log,
          heartbeat,
          label: `MR pipeline !${iid}`,
          signal,
          onNoPipeline: () =>
            ensureMrPipelineStarted(apiBase, token, project, mr, { dryRun, log, signal }),
        }
      );
    }
  }

  log(
    `${label}: merge !${iid} (${mr.source_branch} → ${mr.target_branch}), ` +
      "should_remove_source_branch=false"
  );
  if (dryRun) return mr;

  checkAborted(signal);
  return mergeMergeRequest(apiBase, token, project, iid);
}

async function getOrCreatePromoteMr(
  apiBase,
  token,
  project,
  { developBranch, productionBranch, dryRun, log, signal }
) {
  checkAborted(signal);
  const existing = await listOpenMergeRequests(apiBase, token, project, {
    sourceBranch: developBranch,
    targetBranch: productionBranch,
  });
  if (existing.length) {
    const mr = existing[0];
    log(
      `Promote MR уже открыт: !${mr.iid} (${developBranch} → ${productionBranch})`
    );
    if (!dryRun) {
      await ensureMrPipelineStarted(apiBase, token, project, mr, { dryRun, log, signal });
    }
    return mr;
  }

  const title = `Promote ${developBranch} → ${productionBranch}`;
  log(`Создание promote MR: ${developBranch} → ${productionBranch}`);
  if (dryRun) {
    return {
      iid: 0,
      source_branch: developBranch,
      target_branch: productionBranch,
      state: "opened",
      web_url: "(dry-run)",
    };
  }

  checkAborted(signal);
  const mr = await createMergeRequest(apiBase, token, project, {
    sourceBranch: developBranch,
    targetBranch: productionBranch,
    title,
  });
  await ensureMrPipelineStarted(apiBase, token, project, mr, { dryRun, log, signal });
  return mr;
}
