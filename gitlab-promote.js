/**
 * Promote feature MR → develop → production (master/main).
 * Port of gitlab-promote-mr.py for the extension UI.
 */

import {
  apiRoot,
  branchExists,
  createMergeRequest,
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

const MR_URL_RE =
  /(?:https?:\/\/)?[^/]+\/(?<project>.+?)\/-\/merge_requests\/(?<iid>\d+)/i;
const MR_REF_RE = /^(?<project>.+?)!(?<iid>\d+)$/;
const UNTAGGED_IMAGE_RE = /^Untagged:\s*(.+?)\s*$/gm;
const IMAGE_LINE_RE = /^[^\s:]+:[^\s:]+$/;
const PRODUCTION_SUFFIXES = ["master", "main"];

/**
 * @typedef {{ project: string, iid: number }} MrRef
 * @typedef {(line: string) => void} LogFn
 * @typedef {{ signal?: AbortSignal, log?: LogFn, onBuildImage?: (image: string) => void }} PromoteHooks
 */

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
async function waitPipelineLoop(
  fetchPipelines,
  { timeoutSec, pollSec, log, label, signal }
) {
  const terminalOk = new Set(["success"]);
  const terminalBad = new Set(["failed", "canceled", "skipped"]);
  const deadline = Date.now() + timeoutSec * 1000;
  let seen = null;

  while (Date.now() < deadline) {
    checkAborted(signal);
    const pipelines = await fetchPipelines();
    if (!pipelines.length) {
      log(`  ${label}: ожидание первого pipeline…`);
      await sleep(pollSec * 1000, signal);
      continue;
    }
    const latest = pipelines[0];
    const pid = Number(latest.id);
    const status = String(latest.status);
    if (pid !== seen) {
      seen = pid;
      log(`  ${label} #${pid}: ${status}`);
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
  { timeoutSec, pollSec, log, signal }
) {
  const deadline = Date.now() + timeoutSec * 1000;

  while (Date.now() < deadline) {
    checkAborted(signal);
    const pipelines = await listPipelinesForRef(apiBase, token, project, ref, { perPage: 10 });
    if (!pipelines.length) {
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
      log(
        `  branch pipeline: ожидание нового pipeline на ${JSON.stringify(ref)} ` +
          `(после #${afterPipelineId})…`
      );
      await sleep(pollSec * 1000, signal);
      continue;
    }

    const pid = Number(candidate.id);
    const status = String(candidate.status);
    log(`  branch pipeline #${pid} на ${ref}: ${status}`);

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
 * @param {string} label
 */
function ensureMergeable(mr, label) {
  const state = String(mr.state);
  if (state === "merged") return;
  if (state !== "opened") {
    throw new Error(`${label} MR !${mr.iid} в состоянии ${state}, ожидался opened/merged`);
  }
  const mergeStatus = mr.merge_status || mr.detailed_merge_status;
  if (mergeStatus === "cannot_be_merged" || mergeStatus === "broken") {
    throw new Error(
      `${label} MR !${mr.iid} нельзя смержить (status: ${mergeStatus})`
    );
  }
}

/**
 * @typedef {Object} PromoteOptions
 * @property {string} mrArg
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
  const signal = hooks.signal;

  if (!token?.trim()) {
    throw new Error("Укажите Personal Access Token в настройках (нужен scope api)");
  }

  const ref = parseMrArg(options.mrArg);
  const apiBase = apiRoot(apiBaseUrl);
  const dryRun = Boolean(options.dryRun);
  const pipelineTimeout = options.pipelineTimeoutSec ?? 7200;
  const pollSec = options.pollIntervalSec ?? 20;
  const buildStage = (options.buildStage || "build").trim();

  log(`Проект: ${ref.project}`);
  log(`Feature MR: !${ref.iid}`);

  checkAborted(signal);
  let featureMr = await getMergeRequest(apiBase, token, ref.project, ref.iid);
  const developBranch = String(featureMr.target_branch);
  requireDevelopTarget(developBranch);

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
      ref.project,
      developBranch,
      productionOverride || undefined,
      signal
    );
  }

  log(`Develop:    ${developBranch}`);
  log(`Production: ${productionBranch}`);
  if (dryRun) log("--- dry run ---");

  featureMr = await mergeIfNeeded(apiBase, token, ref.project, featureMr, {
    dryRun,
    label: "Feature",
    waitPipelineBefore: Boolean(options.waitFeaturePipeline),
    pipelineTimeout,
    pollSec,
    log,
    signal,
  });

  if (!dryRun && String(featureMr.state) !== "merged") {
    checkAborted(signal);
    featureMr = await getMergeRequest(apiBase, token, ref.project, ref.iid);
  }
  if (featureMr.web_url) log(`Feature MR: ${featureMr.web_url}`);

  if (options.stopAfterFeature) {
    log("Остановка после merge feature → develop.");
    return {};
  }

  let promoteMr = await getOrCreatePromoteMr(apiBase, token, ref.project, {
    developBranch,
    productionBranch,
    dryRun,
    log,
    signal,
  });

  if (!dryRun) {
    checkAborted(signal);
    promoteMr = await getMergeRequest(apiBase, token, ref.project, Number(promoteMr.iid));
  }
  log(`Promote MR: !${promoteMr.iid} (${promoteMr.web_url || ""})`);

  if (options.stopAfterPromoteMr) {
    log("Остановка после создания promote MR.");
    return {};
  }

  let lastPipelineBeforeMerge = null;
  if (!dryRun) {
    checkAborted(signal);
    const pipelines = await listPipelinesForRef(apiBase, token, ref.project, productionBranch, {
      perPage: 1,
    });
    if (pipelines.length) lastPipelineBeforeMerge = Number(pipelines[0].id);

    log("Ожидание pipeline promote MR…");
    await waitPipelineLoop(
      () => listMrPipelines(apiBase, token, ref.project, Number(promoteMr.iid)),
      {
        timeoutSec: pipelineTimeout,
        pollSec,
        log,
        label: `MR pipeline !${promoteMr.iid}`,
        signal,
      }
    );
  }

  promoteMr = await mergeIfNeeded(apiBase, token, ref.project, promoteMr, {
    dryRun,
    label: "Promote",
    waitPipelineBefore: false,
    pipelineTimeout,
    pollSec,
    log,
    signal,
  });

  if (!dryRun) {
    checkAborted(signal);
    promoteMr = await getMergeRequest(apiBase, token, ref.project, Number(promoteMr.iid));
  }

  let buildImage;
  if (!dryRun && !options.skipBuildImage) {
    log(`Ожидание build pipeline на ${JSON.stringify(productionBranch)}…`);
    const productionPipelineId = await waitBranchPipeline(
      apiBase,
      token,
      ref.project,
      productionBranch,
      lastPipelineBeforeMerge,
      { timeoutSec: pipelineTimeout, pollSec, log, signal }
    );
    buildImage = await extractBuildImage(
      apiBase,
      token,
      ref.project,
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
  { dryRun, label, waitPipelineBefore, pipelineTimeout, pollSec, log, signal }
) {
  const iid = Number(mr.iid);
  if (String(mr.state) === "merged") {
    log(`${label}: уже смержен (!${iid})`);
    return mr;
  }

  ensureMergeable(mr, label);

  if (waitPipelineBefore) {
    log(`${label}: ожидание pipeline перед merge (!${iid})…`);
    if (!dryRun) {
      await waitPipelineLoop(
        () => listMrPipelines(apiBase, token, project, iid),
        {
          timeoutSec: pipelineTimeout,
          pollSec,
          log,
          label: `MR pipeline !${iid}`,
          signal,
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
  return createMergeRequest(apiBase, token, project, {
    sourceBranch: developBranch,
    targetBranch: productionBranch,
    title,
  });
}
