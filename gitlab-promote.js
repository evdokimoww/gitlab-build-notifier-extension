/**
 * Promote feature MR → staging → production.
 * Port of gitlab-promote-mr.py for the extension UI.
 * Сопоставление веток — через настраиваемые маски (см. DEFAULT_BRANCH_MAPPINGS).
 */

import {
  apiRoot,
  createBranch,
  cherryPickCommit,
  getCommit,
  listBackportMergeRequests,
  listMrCommits,
  branchExists,
  createMergeRequest,
  createMrPipeline,
  createRefPipeline,
  getJobArtifact,
  getJobTrace,
  getMergeRequest,
  getProject,
  listMrPipelines,
  listMrPipelinesForSha,
  listOpenMergeRequests,
  listPipelineJobs,
  listPipelinesForRef,
  mergeMergeRequest,
  playJob,
  retryPipeline,
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

/**
 * @param {unknown} err
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * @param {Record<string, unknown>} p
 */
function formatPipelineOne(p) {
  const parts = [`#${p.id}`, String(p.status || "?")];
  if (p.ref) parts.push(`ref=${p.ref}`);
  if (p.sha) parts.push(`sha=${String(p.sha).slice(0, 8)}`);
  if (p.source) parts.push(`source=${p.source}`);
  return parts.join(" ");
}

/**
 * @param {Record<string, unknown>[]} pipelines
 * @param {{ limit?: number, afterPipelineId?: number | null }} [opts]
 */
function formatPipelinesSummary(pipelines, opts = {}) {
  const { limit = 8, afterPipelineId = null } = opts;
  let list = pipelines;
  if (afterPipelineId != null) {
    list = pipelinesAfter(pipelines, afterPipelineId);
  }
  if (!list.length) {
    if (afterPipelineId != null && pipelines.length) {
      return (
        `нет после #${afterPipelineId} (всего ${pipelines.length}: ` +
        `${pipelines
          .slice(0, limit)
          .map(formatPipelineOne)
          .join("; ")})`
      );
    }
    return "нет";
  }
  const shown = list.slice(0, limit).map(formatPipelineOne).join("; ");
  const extra = list.length > limit ? ` (+${list.length - limit} ещё)` : "";
  return `${list.length} шт.: ${shown}${extra}`;
}

/**
 * @param {Record<string, unknown>} mr
 */
function formatMrSummary(mr) {
  const parts = [
    `!${mr.iid}`,
    `state=${mr.state}`,
    `${mr.source_branch}→${mr.target_branch}`,
  ];
  if (mr.merge_status) parts.push(`merge_status=${mr.merge_status}`);
  if (mr.detailed_merge_status) parts.push(`detailed=${mr.detailed_merge_status}`);
  if (mr.has_conflicts === true) parts.push("has_conflicts=true");
  if (mr.sha) parts.push(`sha=${String(mr.sha).slice(0, 8)}`);
  const hp = mr.head_pipeline;
  if (hp && typeof hp === "object") {
    const h = /** @type {Record<string, unknown>} */ (hp);
    parts.push(`head_pipeline=#${h.id} ${h.status}`);
  }
  return parts.join(", ");
}

/**
 * @param {LogFn} log
 * @param {string} label
 * @param {Record<string, unknown>} mr
 */
function logMrSnapshot(log, label, mr) {
  log(`  [MR] ${label}: ${formatMrSummary(mr)}`);
  if (mr.web_url) log(`    url: ${mr.web_url}`);
  if (mr.merge_error) log(`    merge_error: ${JSON.stringify(mr.merge_error)}`);
  if (mr.blocking_discussions_resolved === false) {
    log("    blocking_discussions_resolved=false");
  }
}

/**
 * @param {LogFn} log
 * @param {string} label
 * @param {Record<string, unknown>[]} pipelines
 * @param {{ limit?: number, afterPipelineId?: number | null }} [opts]
 */
function logPipelinesSnapshot(log, label, pipelines, opts = {}) {
  log(`  [pipelines] ${label}: ${formatPipelinesSummary(pipelines, opts)}`);
}

/**
 * @param {LogFn} log
 * @param {string} label
 * @param {Record<string, unknown>[]} pipelines
 * @param {Record<string, unknown>} selected
 * @param {Record<string, unknown>} [latest]
 */
function logPipelineSelection(log, label, pipelines, selected, latest) {
  logPipelinesSnapshot(log, `${label} (все)`, pipelines);
  log(
    `  [pipelines] ${label}: выбран ${formatPipelineOne(selected)}` +
      (latest && Number(latest.id) !== Number(selected.id)
        ? ` (не newest #${latest.id} ${latest.status})`
        : "")
  );
}

/**
 * GitLab 400 when CI rules yield no jobs for the merge request pipeline.
 * @param {string} msg
 */
function isEmptyPipelineError(msg) {
  if (!msg.includes("400")) return false;
  return /would have been empty|resulting pipeline.*empty|rules configuration for the relevant jobs/i.test(
    msg
  );
}

/**
 * @param {Record<string, unknown>[]} pipelines
 */
function hasSuccessOrActivePipeline(pipelines) {
  return pipelines.some((p) => {
    const s = String(p.status);
    return s === "success" || PIPELINE_ACTIVE.has(s);
  });
}

/**
 * @param {Record<string, unknown>[]} pipelines
 */
function hasActivePipeline(pipelines) {
  return pipelines.some((p) => PIPELINE_ACTIVE.has(String(p.status)));
}

/**
 * @param {Record<string, unknown>[]} pipelines
 * @param {number | null | undefined} afterPipelineId
 */
function hasRelevantActivePipeline(pipelines, afterPipelineId) {
  return pipelines.some((p) => {
    const pid = Number(p.id);
    if (afterPipelineId != null && pid <= afterPipelineId) return false;
    return PIPELINE_ACTIVE.has(String(p.status));
  });
}

/**
 * @param {Record<string, unknown>[]} pipelines
 * @param {number | null | undefined} afterPipelineId
 */
function pipelinesAfter(pipelines, afterPipelineId) {
  if (afterPipelineId == null) return pipelines;
  return pipelines.filter((p) => Number(p.id) > afterPipelineId);
}

/**
 * Follow the newest non-skipped pipeline on the newest commit.
 * A newer failed attempt must not be hidden by an earlier success.
 * @param {Record<string, unknown>[]} pipelines
 */
function selectPipelineForWait(pipelines) {
  const newest = pipelines.reduce((a, b) => Number(a.id) > Number(b.id) ? a : b, pipelines[0]);
  const sourceSha = newest?.source_sha || newest?.sha;
  if (sourceSha) pipelines = pipelines.filter(p => (p.source_sha || p.sha) === sourceSha);
  const candidates = pipelines.filter(p => String(p.status) !== "skipped");
  return (candidates.length ? candidates : pipelines)
    .reduce((a, b) => Number(a.id) > Number(b.id) ? a : b);
}

const MR_URL_RE =
  /(?:https?:\/\/)?[^/]+\/(?<project>.+?)\/-\/merge_requests\/(?<iid>\d+)/i;
const MR_REF_RE = /^(?<project>.+?)!(?<iid>\d+)$/;
const UNTAGGED_IMAGE_RE = /Untagged:\s*(\S+)/g;
const IMAGE_LINE_RE = /^[^\s:]+:[^\s:]+$/;

/**
 * Правила сопоставления staging → production (по одной маске на строку).
 * `*` — один сегмент пути (без `/`). Справа через запятую — кандидаты.
 * Порядок: первое совпадение побеждает.
 */
export const DEFAULT_BRANCH_MAPPINGS = `# Стандартный флоу: feature → develop → master|main
develop → master, main

# Префикс пути: team/develop → team/master
*/develop → */master, */main

# Суффикс: develop-env → master-env
develop-* → master-*, main-*

# Префикс + суффикс: team/develop-env → team/master-env
*/develop-* → */master-*, */main-*
`;

/**
 * @typedef {{ project: string, iid: number }} MrRef
 * @typedef {(line: string) => void} LogFn
 * @typedef {{ progress?: Record<string, unknown>, onProgress?: (progress: Record<string, unknown>) => Promise<void>, onPipelineState?: (state: Record<string, unknown>) => Promise<void>, signal?: AbortSignal, log?: LogFn, heartbeat?: () => void, onBuildImage?: (image: string) => void, onConflict?: (mr: Record<string, unknown>, message: string) => void }} PromoteHooks
 * @typedef {{ staging: string, production: string[] }} BranchMappingRule
 * @typedef {{ rule: BranchMappingRule, captures: string[], candidates: string[] }} BranchMappingMatch
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
 * @param {string} text
 * @returns {string}
 */
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Маска с `*` → RegExp: каждый `*` захватывает один сегмент (`[^/]*`).
 * @param {string} pattern
 * @returns {RegExp}
 */
function maskToRegExp(pattern) {
  const parts = pattern.split("*");
  let source = "^";
  for (let i = 0; i < parts.length; i++) {
    source += escapeRegex(parts[i]);
    if (i < parts.length - 1) source += "([^/]*)";
  }
  source += "$";
  return new RegExp(source, "i");
}

/**
 * Подставить захваты `*` в шаблон production-ветки.
 * @param {string} template
 * @param {string[]} captures
 */
function expandMask(template, captures) {
  let i = 0;
  return template.replace(/\*/g, () => captures[i++] ?? "");
}

/**
 * Первое «слово» в маске — для bare override (`master` → соответствующий кандидат).
 * @param {string} template
 */
function maskKeyword(template) {
  const m = template.match(/[a-zA-Z0-9]+/);
  return m ? m[0].toLowerCase() : "";
}

/**
 * Разобрать текст правил из настроек.
 * @param {string} [text]
 * @returns {BranchMappingRule[]}
 */
export function parseBranchMappings(text) {
  const raw = (text ?? "").trim() ? text : DEFAULT_BRANCH_MAPPINGS;
  /** @type {BranchMappingRule[]} */
  const rules = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const arrow = trimmed.split(/\s*→\s*|\s*->\s*/);
    if (arrow.length !== 2) {
      throw new Error(
        `Некорректное правило сопоставления веток: ${JSON.stringify(trimmed)}. ` +
          `Ожидается: staging → production[, production…]`
      );
    }
    const staging = arrow[0].trim();
    const production = arrow[1]
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (!staging || !production.length) {
      throw new Error(
        `Некорректное правило сопоставления веток: ${JSON.stringify(trimmed)}`
      );
    }
    const stagingStars = (staging.match(/\*/g) || []).length;
    for (const prod of production) {
      const prodStars = (prod.match(/\*/g) || []).length;
      if (prodStars !== stagingStars) {
        throw new Error(
          `В правиле ${JSON.stringify(trimmed)} число \`*\` слева (${stagingStars}) ` +
            `не совпадает с ${JSON.stringify(prod)} (${prodStars})`
        );
      }
    }
    rules.push({ staging, production });
  }
  if (!rules.length) {
    throw new Error(
      "Нет правил сопоставления веток. Добавьте хотя бы одно в настройках " +
        "(например: develop → master, main)"
    );
  }
  return rules;
}

/**
 * @param {string} stagingBranch
 * @param {BranchMappingRule[]} rules
 * @returns {BranchMappingMatch}
 */
export function matchBranchMapping(stagingBranch, rules) {
  for (const rule of rules) {
    const re = maskToRegExp(rule.staging);
    const m = re.exec(stagingBranch);
    if (!m) continue;
    const captures = m.slice(1);
    const candidates = rule.production.map((tmpl) => expandMask(tmpl, captures));
    return { rule, captures, candidates };
  }
  throw new Error(
    `Target-ветка ${JSON.stringify(stagingBranch)} не подходит ни под одно правило staging. ` +
      `Настройте маски в параметрах расширения (сейчас: ${rules
        .map((r) => r.staging)
        .join(", ")})`
  );
}

/** Reverse the configured masks, preserving path prefixes and suffixes. */
export function guaranteeDevelopBranch(targetBranch, rules = parseBranchMappings()) {
  const candidates = new Set();
  for (const rule of rules) {
    for (const template of rule.production) {
      const match = maskToRegExp(template).exec(targetBranch);
      if (match) candidates.add(expandMask(rule.staging, match.slice(1)));
    }
  }
  if (candidates.size > 1) {
    throw new Error(`Для ${targetBranch} неоднозначная develop-ветка: ${[...candidates].join(", ")}. Уточните маски в настройках.`);
  }
  return [...candidates][0] || null;
}

/**
 * @param {string} targetBranch
 * @param {BranchMappingRule[]} rules
 */
export function requireStagingTarget(targetBranch, rules) {
  matchBranchMapping(targetBranch, rules);
}

/**
 * @deprecated используйте requireStagingTarget
 * @param {string} targetBranch
 * @param {BranchMappingRule[]} [rules]
 */
export function requireDevelopTarget(targetBranch, rules) {
  requireStagingTarget(targetBranch, rules ?? parseBranchMappings());
}

/**
 * Кандидаты production-веток по маскам из настроек.
 * @param {string} developBranch
 * @param {BranchMappingRule[] | string} [mappings]
 * @returns {{ prefix: string | null, leaf: string, candidates: string[], match: BranchMappingMatch }}
 */
export function productionCandidates(developBranch, mappings) {
  const rules =
    typeof mappings === "string" || mappings == null
      ? parseBranchMappings(mappings)
      : mappings;
  const match = matchBranchMapping(developBranch, rules);
  const parts = developBranch.split("/");
  const leaf = parts[parts.length - 1];
  const prefix = parts.length >= 2 ? parts.slice(0, -1).join("/") : null;
  return { prefix, leaf, candidates: match.candidates, match };
}

/**
 * @param {BranchMappingMatch} match
 * @param {string} override
 */
function resolveProductionOverride(match, override) {
  const o = override.trim();
  if (match.candidates.includes(o)) return o;

  const bare = !o.includes("/");
  if (bare) {
    const byKeyword = match.rule.production.find(
      (tmpl) => maskKeyword(tmpl) === o.toLowerCase()
    );
    if (byKeyword) return expandMask(byKeyword, match.captures);

    const byLeaf = match.candidates.filter((c) => c.split("/").pop() === o);
    if (byLeaf.length === 1) return byLeaf[0];
  }

  return o;
}

/**
 * @param {string} apiBase
 * @param {string} token
 * @param {string} project
 * @param {string} developBranch
 * @param {string | undefined} override
 * @param {AbortSignal} [signal]
 * @param {BranchMappingRule[] | string} [mappings]
 */
export async function resolveProductionBranch(
  apiBase,
  token,
  project,
  developBranch,
  override,
  signal,
  mappings
) {
  const { candidates, match } = productionCandidates(developBranch, mappings);

  if (override?.trim()) {
    const branch = resolveProductionOverride(match, override);
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
    if (existing.includes(defaultBranch)) return defaultBranch;
    const byDefaultKeyword = match.rule.production.find(
      (tmpl) => maskKeyword(tmpl) === defaultBranch.toLowerCase()
    );
    if (byDefaultKeyword) {
      const preferred = expandMask(byDefaultKeyword, match.captures);
      if (existing.includes(preferred)) return preferred;
    }
    return existing[0];
  }

  // existing.length === 0 — fallback на default_branch проекта, если он среди кандидатов
  if (candidates.includes(defaultBranch)) {
    checkAborted(signal);
    if (await branchExists(apiBase, token, project, defaultBranch)) return defaultBranch;
  }
  const byDefaultKeyword = match.rule.production.find(
    (tmpl) => maskKeyword(tmpl) === defaultBranch.toLowerCase()
  );
  if (byDefaultKeyword) {
    const fallback = expandMask(byDefaultKeyword, match.captures);
    checkAborted(signal);
    if (await branchExists(apiBase, token, project, fallback)) return fallback;
  }

  throw new Error(
    `Production-ветка для ${JSON.stringify(developBranch)} не найдена в ${project} ` +
      `(пробовали: ${candidates.join(", ")}; default_branch: ${defaultBranch})`
  );
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
 * @param {{ mrApiUnsupported?: boolean }} pipelineCtx
 */
async function waitForMrAutoPipeline(
  apiBase,
  token,
  project,
  mr,
  { log, signal, pipelineCtx }
) {
  const iid = Number(mr.iid);
  const deadline = Date.now() + 15000;
  let lastPipelines = [];
  while (Date.now() < deadline) {
    checkAborted(signal);
    lastPipelines = await listMrPipelines(apiBase, token, project, iid);
    if (hasActivePipeline(lastPipelines)) {
      const active = lastPipelines.find((p) => PIPELINE_ACTIVE.has(String(p.status)));
      const p = active ?? lastPipelines[0];
      log(`  GitLab запустил MR pipeline ${formatPipelineOne(p)}`);
      logPipelinesSnapshot(log, `MR !${iid} (auto-start)`, lastPipelines);
      return;
    }
    await sleep(3000, signal);
  }
  logPipelinesSnapshot(log, `MR !${iid} (auto-start timeout 15s)`, lastPipelines);
  log("  GitLab не запустил MR pipeline за 15 с — продолжаем, запустим вручную при необходимости");
}

/**
 * @param {Record<string, unknown>} mr
 * @param {{ mrApiUnsupported?: boolean, emptyPipelineOk?: boolean, mrPipelineEmpty?: boolean }} [pipelineCtx]
 * @returns {Promise<number | null>} id созданного pipeline или null
 */
async function ensureMrPipelineStarted(
  apiBase,
  token,
  project,
  mr,
  { dryRun, log, signal, pipelineCtx = null }
) {
  if (dryRun) return null;

  const iid = Number(mr.iid);
  if (pipelineCtx?.mrPipelineEmpty) {
    log(`MR !${iid}: пропуск запуска pipeline (mrPipelineEmpty=true)`);
    return null;
  }

  const sourceBranch = String(mr.source_branch || "");
  checkAborted(signal);
  const pipelines = await listMrPipelinesForSha(apiBase, token, project, mr);
  if (hasSuccessOrActivePipeline(pipelines) || pipelines.some(p => ["failed", "canceled"].includes(String(p.status)))) {
    log(`MR !${iid}: pipeline уже есть на MR`);
    logPipelinesSnapshot(log, `MR !${iid}`, pipelines);
    return null;
  }

  let branchPipelines = [];
  if (sourceBranch) {
    checkAborted(signal);
    branchPipelines = (await listPipelinesForRef(apiBase, token, project, sourceBranch, {
      perPage: 10,
    })).filter(p => !mr.sha || p.sha === mr.sha);
    if (hasSuccessOrActivePipeline(branchPipelines) || branchPipelines.some(p => ["failed", "canceled"].includes(String(p.status)) && (!mr.sha || p.sha === mr.sha))) {
      log(`MR !${iid}: pipeline уже есть на ветке ${JSON.stringify(sourceBranch)}`);
      logPipelinesSnapshot(log, `MR !${iid}`, pipelines);
      logPipelinesSnapshot(log, `ветка ${sourceBranch}`, branchPipelines);
      return null;
    }
  }

  log(`MR !${iid}: pipeline не запущен, запуск…`);
  logPipelinesSnapshot(log, `MR !${iid} (перед create)`, pipelines);
  if (sourceBranch) {
    logPipelinesSnapshot(log, `ветка ${sourceBranch} (перед create)`, branchPipelines);
  }
  let createdId = null;

  const skipMrApi = pipelineCtx?.mrApiUnsupported;
  if (!skipMrApi) {
    try {
      const created = await createMrPipeline(apiBase, token, project, iid);
      createdId = Number(created.id);
      log(`  создан MR pipeline #${createdId} (${String(created.status || "created")})`);
      await sleep(3000, signal);
      return createdId;
    } catch (firstErr) {
      const msg = formatError(firstErr);
      if (isEmptyPipelineError(msg)) {
        if (pipelineCtx?.emptyPipelineOk) {
          checkAborted(signal);
          const freshMrPipelines = await listMrPipelines(apiBase, token, project, iid);
          const freshBranchPipelines = sourceBranch
            ? await listPipelinesForRef(apiBase, token, project, sourceBranch, { perPage: 10 })
            : [];
          log(`  MR pipeline API: 400 empty pipeline — ${msg}`);
          logPipelinesSnapshot(log, `MR !${iid} (после empty error)`, freshMrPipelines);
          if (sourceBranch) {
            logPipelinesSnapshot(log, `ветка ${sourceBranch} (после empty error)`, freshBranchPipelines);
          }
          if (
            hasSuccessOrActivePipeline(freshMrPipelines) ||
            hasSuccessOrActivePipeline(freshBranchPipelines)
          ) {
            log("  MR pipeline API: пустой pipeline по rules, но CI уже запущен — ждём…");
            return null;
          }
          if (!freshMrPipelines.length && !freshBranchPipelines.length) {
            pipelineCtx.mrPipelineEmpty = true;
            log("  CI не требует pipeline для MR (пустой pipeline по rules, pipeline не найдены)");
          } else {
            log(
              "  CI вернул empty pipeline, но есть terminal pipeline — ждём в waitPipelineLoop"
            );
          }
          return null;
        }
      } else if (msg.includes("405")) {
        if (pipelineCtx) pipelineCtx.mrApiUnsupported = true;
        log(`  MR pipeline API не поддерживается (405), запуск на ветке…`);
      } else {
        log(`  MR pipeline API ошибка: ${msg}`);
      }
      if (!sourceBranch) throw firstErr;
    }
  } else {
    log(`  MR pipeline API пропущен (mrApiUnsupported=true), fallback на ветку…`);
  }

  checkAborted(signal);
  branchPipelines = sourceBranch
    ? await listPipelinesForRef(apiBase, token, project, sourceBranch, { perPage: 10 })
    : [];
  if (hasSuccessOrActivePipeline(branchPipelines)) {
    log(`  на ветке ${JSON.stringify(sourceBranch)} уже есть pipeline`);
    logPipelinesSnapshot(log, `ветка ${sourceBranch}`, branchPipelines);
    return null;
  }

  log(`  запуск pipeline на ветке ${JSON.stringify(sourceBranch)}…`);
  const created = await createRefPipeline(apiBase, token, project, sourceBranch);
  createdId = Number(created.id);
  log(`  создан branch pipeline #${createdId} (${String(created.status || "created")})`);
  await sleep(3000, signal);
  return createdId;
}

/**
 * @param {Record<string, unknown>[]} pipelines
 */
function hasPushPipeline(pipelines) {
  return pipelines.some((p) => String(p.source || "") === "push");
}

/**
 * @param {number | null} afterPipelineId
 * @param {{ dryRun?: boolean, log: LogFn, signal?: AbortSignal }} opts
 *
 * Не создаём API-pipeline, если GitLab уже создал push (даже skipped):
 * на multi-region master API почти всегда уходит в skipped и может
 * пометить push как duplicate.
 */
async function ensureBranchPipelineStarted(
  apiBase,
  token,
  project,
  ref,
  afterPipelineId,
  { dryRun, log, signal, expectedSha }
) {
  if (dryRun) return;

  checkAborted(signal);
  const pipelines = (await listPipelinesForRef(apiBase, token, project, ref, { perPage: 10, sha: expectedSha }))
    .filter(p => !expectedSha || p.sha === expectedSha);
  const newer = pipelinesAfter(pipelines, afterPipelineId);

  if (hasRelevantActivePipeline(pipelines, afterPipelineId)) {
    log(`  [branch] ${ref}: активный pipeline после baseline #${afterPipelineId ?? "—"}`);
    logPipelinesSnapshot(log, ref, newer.length ? newer : pipelines);
    return;
  }

  if (hasSuccessOrActivePipeline(newer)) {
    log(
      `  [branch] ${ref}: success/active pipeline после baseline #${afterPipelineId ?? "—"} уже есть`
    );
    logPipelinesSnapshot(log, ref, newer);
    return;
  }

  if (newer.length) {
    if (hasPushPipeline(newer)) {
      log(
        `  [branch] ${ref}: push-pipeline уже есть после baseline — API create пропускаем ` +
          `(source=api на master обычно skipped)`
      );
      logPipelinesSnapshot(log, ref, newer);
      return;
    }
    log(
      `  [branch] ${ref}: после baseline есть pipeline без push — API create пропускаем, ждём`
    );
    logPipelinesSnapshot(log, ref, newer);
    return;
  }

  log(`Ветка ${JSON.stringify(ref)}: pipeline не запущен, запуск через API…`);
  logPipelinesSnapshot(log, `${ref} (перед create)`, pipelines, { afterPipelineId });
  if (expectedSha && (await getCommit(apiBase, token, project, ref)).id !== expectedSha) {
    throw new Error(`Ветка ${ref} изменилась после merge. Нельзя запустить сборку ${expectedSha}. Повторите запуск.`);
  }
  const created = await createRefPipeline(apiBase, token, project, ref);
  log(
    `  создан branch pipeline #${created.id} (${String(created.status || "created")}, source=api)`
  );
  await sleep(3000, signal);
}

async function waitPipelineLoop(
  fetchPipelines,
  {
    timeoutSec,
    pollSec,
    log,
    label,
    signal,
    onNoPipeline,
    heartbeat,
    afterPipelineId = null,
    emptyPipelineOk = false,
    pipelineCtx = null,
    /** Ждать push/auto pipeline столько мс, прежде чем вызывать onNoPipeline. */
    createGraceMs = 0,
    /**
     * После all-skipped ждать столько мс появления non-skipped pipeline
     * (не создавать API — на master source=api обычно сразу skipped).
     */
    skippedGraceMs = 0,
    /**
     * После skipped-grace: retry/play существующего pipeline (как вручную в UI).
     * @type {((relevant: Record<string, unknown>[]) => Promise<void>) | null | undefined}
     */
    onSkippedRecover = null,
    /**
     * Pipeline в status=manual — play manual jobs.
     * @type {((pipeline: Record<string, unknown>) => Promise<void>) | null | undefined}
     */
    onManualPipeline = null,
    onPipelineState,
  }
) {
  const ctx = { log, heartbeat };
  const terminalOk = new Set(["success"]);
  const terminalBad = new Set(["failed", "canceled", "skipped"]);
  const deadline = Date.now() + timeoutSec * 1000;
  let seen = null;
  let seenStatus = null;
  let triedStart = false;
  let skippedRetried = false;
  let skippedRecovered = false;
  let manualPlayed = false;
  let skippedGraceStartedAt = null;
  const loopStartedAt = Date.now();
  let waitStartedAt = Date.now();
  let lastProgressLogAt = 0;
  let lastPipelines = [];
  let lastGraceLogAt = 0;
  let lastSkippedLogAt = 0;

  while (Date.now() < deadline) {
    checkAborted(signal);
    pulseWait(ctx);
    const pipelines = await fetchPipelines();
    checkAborted(signal);
    lastPipelines = pipelines;
    const relevant = pipelinesAfter(pipelines, afterPipelineId);
    if (!relevant.length) {
      skippedGraceStartedAt = null;
      const elapsed = Date.now() - loopStartedAt;
      if (!triedStart && onNoPipeline && elapsed < createGraceMs) {
        if (Date.now() - lastGraceLogAt >= 10000) {
          lastGraceLogAt = Date.now();
          const leftSec = Math.ceil((createGraceMs - elapsed) / 1000);
          log(
            `  ${label}: ждём pipeline от GitLab (push после merge), ` +
              `API-запуск через ~${leftSec}с…`
          );
          logPipelinesSnapshot(log, `${label} (все)`, pipelines, { afterPipelineId });
        }
        await sleep(Math.min(pollSec * 1000, 5000), signal);
        continue;
      }
      if (!triedStart && onNoPipeline) {
        triedStart = true;
        log(
          `  ${label}: pipeline не найден` +
            (afterPipelineId != null ? ` (после #${afterPipelineId})` : "") +
            (createGraceMs > 0 ? ` за ${Math.round(createGraceMs / 1000)}с` : "") +
            ", пробуем запустить…"
        );
        logPipelinesSnapshot(log, `${label} (все)`, pipelines, { afterPipelineId });
        await onNoPipeline();
        continue;
      }
      log(`  ${label}: ожидание первого pipeline…`);
      logPipelinesSnapshot(log, `${label} (все)`, pipelines, { afterPipelineId });
      await sleep(pollSec * 1000, signal);
      continue;
    }
    const latest = relevant.reduce((a, b) => Number(a.id) > Number(b.id) ? a : b);
    const candidate = selectPipelineForWait(relevant);
    const pid = Number(candidate.id);
    const status = String(candidate.status);
    if (Number(latest.id) !== pid && String(latest.status) === "skipped") {
      log(`  ${label}: игнорируем #${latest.id} (skipped), ждём #${pid} (${status})`);
      logPipelineSelection(log, label, relevant, candidate, latest);
    }
    const statusChanged = pid !== seen || status !== seenStatus;
    if (statusChanged) {
      seen = pid;
      seenStatus = status;
      await onPipelineState?.({ label, pipelineId: pid, status, sha: candidate.sha,
        waitingForRetry: status === "failed" || status === "canceled" });
      waitStartedAt = Date.now();
      lastProgressLogAt = waitStartedAt;
      log(`  ${label} #${pid}: ${status}`);
      if (Number(latest.id) !== pid || relevant.length > 1) {
        logPipelineSelection(log, label, relevant, candidate, latest);
      }
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
    if (status === "failed" || status === "canceled") {
      if (statusChanged) {
        log(`  ${label} #${pid}: ${status}. Ждём ручного перезапуска в GitLab…`);
      }
      await sleep(pollSec * 1000, signal);
      continue;
    }
    if (status === "manual" && onManualPipeline && !manualPlayed) {
      manualPlayed = true;
      log(`  ${label} #${pid}: status=manual — запускаем manual jobs…`);
      logPipelineSelection(log, label, relevant, candidate, latest);
      await onManualPipeline(candidate);
      seen = null;
      await sleep(3000, signal);
      continue;
    }
    if (terminalBad.has(status)) {
      if (
        status === "skipped" &&
        emptyPipelineOk &&
        !hasSuccessOrActivePipeline(relevant)
      ) {
        log(`  ${label}: pipeline skipped (нет jobs по CI rules), продолжаем…`);
        return null;
      }
      const allSkipped =
        status === "skipped" &&
        relevant.every((p) => String(p.status) === "skipped");
      if (allSkipped && skippedGraceMs > 0 && !skippedRecovered) {
        if (skippedGraceStartedAt == null) {
          skippedGraceStartedAt = Date.now();
          log(
            `  ${label}: все pipeline skipped — ждём до ${Math.round(skippedGraceMs / 1000)}с ` +
              `появления success/running…`
          );
          logPipelinesSnapshot(log, `${label} (all skipped)`, relevant);
        }
        const skippedElapsed = Date.now() - skippedGraceStartedAt;
        if (skippedElapsed < skippedGraceMs) {
          if (Date.now() - lastSkippedLogAt >= 15000) {
            lastSkippedLogAt = Date.now();
            const leftSec = Math.ceil((skippedGraceMs - skippedElapsed) / 1000);
            log(`  ${label}: всё ещё только skipped, осталось ~${leftSec}с…`);
            logPipelinesSnapshot(log, `${label}`, relevant);
          }
          await sleep(Math.min(pollSec * 1000, 5000), signal);
          continue;
        }
        if (onSkippedRecover) {
          skippedRecovered = true;
          log(
            `  ${label}: skipped-grace истёк — retry/play pipeline ` +
              `(как ручной запуск в GitLab UI)…`
          );
          logPipelinesSnapshot(log, `${label} (before recover)`, relevant);
          await onSkippedRecover(relevant);
          seen = null;
          await sleep(3000, signal);
          continue;
        }
      } else if (allSkipped && !skippedRetried && onNoPipeline && skippedGraceMs === 0) {
        // MR pipeline: один повторный запуск (не для branch/master — там skippedGrace).
        skippedRetried = true;
        log(`  ${label}: все новые pipeline skipped, повторный запуск…`);
        logPipelinesSnapshot(log, `${label} (all skipped)`, relevant);
        await onNoPipeline();
        if (pipelineCtx?.mrPipelineEmpty) {
          log(`  ${label}: CI не требует pipeline, продолжаем…`);
          return null;
        }
        seen = null;
        continue;
      }
      logPipelinesSnapshot(log, `${label} (terminal ${status})`, relevant);
      throw new Error(
        `${label} #${pid} завершился: ${status} | pipelines: ${formatPipelinesSummary(relevant)}`
      );
    }
    skippedGraceStartedAt = null;
    await sleep(pollSec * 1000, signal);
  }
  logPipelinesSnapshot(log, `${label} (timeout ${timeoutSec}s)`, lastPipelines, {
    afterPipelineId,
  });
  throw new Error(
    `${label}: pipeline не успел за ${timeoutSec} с` +
      (afterPipelineId != null ? ` (после #${afterPipelineId})` : "") +
      ` | последнее: ${formatPipelinesSummary(lastPipelines, { afterPipelineId })}`
  );
}

/** После merge на production ждём push-pipeline, прежде чем создавать через API. */
const BRANCH_PIPELINE_PUSH_GRACE_MS = 90_000;
/** Короткое ожидание: иногда следом появляется второй pipeline; иначе — retry. */
const BRANCH_PIPELINE_SKIPPED_GRACE_MS = 20_000;

/**
 * Как ручной Retry/Play в GitLab UI: поднять skipped/manual jobs на production.
 * @param {string} apiBase
 * @param {string} token
 * @param {string} project
 * @param {number} pipelineId
 * @param {LogFn} log
 * @param {AbortSignal} [signal]
 */
async function recoverBranchPipelineJobs(
  apiBase,
  token,
  project,
  pipelineId,
  log,
  signal
) {
  checkAborted(signal);
  let jobs = [];
  try {
    jobs = await listPipelineJobs(apiBase, token, project, pipelineId);
  } catch (err) {
    log(`  [recover] не удалось прочитать jobs #${pipelineId}: ${formatError(err)}`);
  }

  if (jobs.length) {
    log(
      `  [recover] pipeline #${pipelineId} jobs: ` +
        jobs.map((j) => `#${j.id} ${j.name}(${j.stage}/${j.status})`).join("; ")
    );
  } else {
    log(`  [recover] pipeline #${pipelineId}: jobs пусто`);
  }

  const manualJobs = jobs.filter((j) => String(j.status) === "manual");
  if (manualJobs.length) {
    for (const job of manualJobs) {
      checkAborted(signal);
      log(`  [recover] play manual job #${job.id} ${job.name}…`);
      try {
        const played = await playJob(apiBase, token, project, Number(job.id));
        log(`  [recover] job #${job.id} → ${String(played.status || "playing")}`);
      } catch (err) {
        log(`  [recover] play #${job.id} не удался: ${formatError(err)}`);
      }
    }
    await sleep(3000, signal);
    return;
  }

  const retryable = jobs.filter((j) =>
    ["skipped", "failed", "canceled"].includes(String(j.status))
  );
  if (!jobs.length || retryable.length) {
    checkAborted(signal);
    log(`  [recover] retry pipeline #${pipelineId}…`);
    try {
      const retried = await retryPipeline(apiBase, token, project, pipelineId);
      log(
        `  [recover] pipeline #${pipelineId} после retry: ${String(retried.status || "?")}`
      );
    } catch (err) {
      log(`  [recover] retry #${pipelineId} не удался: ${formatError(err)}`);
    }
    await sleep(3000, signal);
  }
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
  { timeoutSec, pollSec, log, signal, dryRun, heartbeat, onPipelineState, expectedSha }
) {
  const label = `branch pipeline ${ref}`;
  const ensurePipeline = dryRun
    ? undefined
    : () =>
        ensureBranchPipelineStarted(apiBase, token, project, ref, afterPipelineId, {
          dryRun,
          log,
          signal,
          expectedSha,
        });

  /**
   * @param {Record<string, unknown>[]} relevant
   */
  const recoverSkipped = async (relevant) => {
    const pushSkipped = relevant.find(
      (p) => String(p.source) === "push" && String(p.status) === "skipped"
    );
    const anySkipped = relevant.find((p) => String(p.status) === "skipped");
    const target = pushSkipped || anySkipped;
    if (!target) return;
    await recoverBranchPipelineJobs(
      apiBase,
      token,
      project,
      Number(target.id),
      log,
      signal
    );
  };

  /**
   * @param {Record<string, unknown>} pipeline
   */
  const recoverManual = async (pipeline) => {
    await recoverBranchPipelineJobs(
      apiBase,
      token,
      project,
      Number(pipeline.id),
      log,
      signal
    );
  };

  // Не создаём API-pipeline сразу после merge: GitLab сам запускает source=push.
  // Ранний API на master обычно skipped и может «убить» push как duplicate.
  // Если push сразу skipped — после короткого grace делаем retry (как вручную в UI).
  if (!dryRun) {
    log(
      `  [branch] ${ref}: ждём push-pipeline после merge` +
        ` (API fallback только если pipeline нет ~${Math.round(BRANCH_PIPELINE_PUSH_GRACE_MS / 1000)}с; ` +
        `при skipped ~${Math.round(BRANCH_PIPELINE_SKIPPED_GRACE_MS / 1000)}с → retry)…`
    );
  }

  let pipelineId;
  try {
    pipelineId = await waitPipelineLoop(
      async () => (await listPipelinesForRef(apiBase, token, project, ref, { perPage: 10, sha: expectedSha }))
        .filter(p => !expectedSha || p.sha === expectedSha),
      {
        timeoutSec,
        pollSec,
        log,
        label,
        signal,
        heartbeat,
        onPipelineState,
        afterPipelineId,
        createGraceMs: dryRun ? 0 : BRANCH_PIPELINE_PUSH_GRACE_MS,
        skippedGraceMs: dryRun ? 0 : BRANCH_PIPELINE_SKIPPED_GRACE_MS,
        onNoPipeline: ensurePipeline,
        onSkippedRecover: dryRun ? undefined : recoverSkipped,
        onManualPipeline: dryRun ? undefined : recoverManual,
      }
    );
  } catch (err) {
    const msg = formatError(err);
    if (/skipped/i.test(msg) && !dryRun) {
      checkAborted(signal);
      const pipelines = await listPipelinesForRef(apiBase, token, project, ref, {
        perPage: 10,
      });
      const relevant = pipelinesAfter(pipelines, afterPipelineId);
      logPipelinesSnapshot(log, `${ref} (диагностика skipped)`, relevant);
      const pushSkipped = relevant.find(
        (p) => String(p.source) === "push" && String(p.status) === "skipped"
      );
      const diagnoseId = Number((pushSkipped || relevant[0])?.id);
      if (diagnoseId) {
        try {
          const jobs = await listPipelineJobs(apiBase, token, project, diagnoseId);
          if (!jobs.length) {
            log(
              `  [jobs] pipeline #${diagnoseId}: jobs пусто — CI rules не создали jobs ` +
                `(типично для source=api или workflow:rules)`
            );
          } else {
            log(
              `  [jobs] pipeline #${diagnoseId}: ${jobs.length} шт. — ` +
                jobs
                  .map((j) => `#${j.id} ${j.name}(${j.stage}/${j.status})`)
                  .join("; ")
            );
          }
        } catch (jobsErr) {
          log(`  [jobs] не удалось прочитать jobs #${diagnoseId}: ${formatError(jobsErr)}`);
        }
      }
      throw new Error(
        `${msg}\n` +
          `  Подсказка: на ${JSON.stringify(ref)} сборка обычно идёт из source=push; ` +
          `расширение уже пробовало retry/play. Если всё ещё skipped — откройте pipeline ` +
          `#${diagnoseId || "?"} в GitLab UI.`
      );
    }
    throw err;
  }

  if (pipelineId == null) {
    throw new Error(
      `Build pipeline на ${JSON.stringify(ref)} не найден (все pipeline skipped, CI rules)`
    );
  }
  log(`  build pipeline готов: #${pipelineId}`);
  return pipelineId;
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
  const jobLines = jobs
    .map((j) => `#${j.id} ${j.name} stage=${j.stage} status=${j.status}`)
    .join("; ");
  const stages = [...new Set(jobs.map((j) => String(j.stage || "")))].sort().join(", ");
  throw new Error(
    `CI job для стадии ${JSON.stringify(stageName)} не найден. ` +
      `Доступные stage: ${stages}. Jobs: ${jobLines || "нет"}`
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
 * GitLab runner prefixes trace lines with ANSI codes and uses \r for progress updates.
 * @param {string} trace
 */
function normalizeJobTrace(trace) {
  return trace.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\r/g, "\n");
}

/**
 * @param {string} trace
 */
function parseImageFromTrace(trace) {
  const matches = [...normalizeJobTrace(trace).matchAll(UNTAGGED_IMAGE_RE)];
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
  log(
    `  [jobs] pipeline #${pipelineId}: ${jobs.length} шт. — ` +
      jobs.map((j) => `#${j.id} ${j.name}(${j.stage}/${j.status})`).join("; ")
  );
  const buildJob = findBuildJob(jobs, stageName);
  const jobId = Number(buildJob.id);
  const jobName = buildJob.name || buildJob.stage;
  log(`Чтение образа из job #${jobId} (${jobName}, stage=${buildJob.stage})`);

  return extractJobBuildImage(apiBase, token, project, jobId, log, signal);
}

/** Read the build image from artifacts, falling back to the completed job trace. */
export async function extractJobBuildImage(apiBase, token, project, jobId, log = () => {}, signal) {
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
 * @param {LogFn} [log]
 */
function throwIfConflict(mr, label, hooks, log) {
  if (!mrHasConflict(mr)) return;
  const target = String(mr.target_branch || "");
  if (log) logMrSnapshot(log, `${label} конфликт`, mr);
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
 * @param {LogFn} [log]
 */
function ensureMergeable(mr, label, hooks, log) {
  const state = String(mr.state);
  if (state === "merged") return;
  if (state !== "opened") {
    if (log) logMrSnapshot(log, `${label} неверное состояние`, mr);
    throw new Error(`${label} MR !${mr.iid} в состоянии ${state}, ожидался opened/merged`);
  }
  throwIfConflict(mr, label, hooks, log);
  const mergeStatus = mr.merge_status || mr.detailed_merge_status;
  if (mergeStatus === "checking") {
    if (log) log(`  [MR] ${label} !${mr.iid}: merge_status=checking, ждём проверку…`);
    return;
  }
  if (mergeStatus === "cannot_be_merged" || mergeStatus === "broken") {
    throwIfConflict(mr, label, hooks, log);
    if (log) logMrSnapshot(log, `${label} нельзя смержить`, mr);
    throw new Error(
      `${label} MR !${mr.iid} нельзя смержить (merge_status=${mergeStatus}, ` +
        `detailed=${mr.detailed_merge_status || "—"})`
    );
  }
}

/**
 * @param {string} apiBase
 * @param {string} token
 * @param {MrRef[]} refs
 * @param {BranchMappingRule[]} rules
 * @param {AbortSignal} [signal]
 */
async function loadAndValidateBatch(apiBase, token, refs, rules, signal) {
  const mrs = [];
  for (const ref of refs) {
    checkAborted(signal);
    const mr = await getMergeRequest(apiBase, token, ref.project, ref.iid);
    if (!guaranteeDevelopBranch(String(mr.target_branch), rules)) {
      requireStagingTarget(String(mr.target_branch), rules);
    }
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
        `MR !${refs[i].iid} target ${target} ≠ ${developBranch} — все MR должны идти в одну целевую ветку`
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
 * @property {string} [branchMappings] Текст правил staging → production из настроек
 */

/**
 * @typedef {{
 *   kind: 'feature' | 'develop-build' | 'promote-create' | 'promote' | 'build' | 'guarantee-merge' | 'cherry-pick' | 'backport',
 *   label: string,
 *   sourceBranch?: string,
 *   targetBranch?: string,
 *   mrIid?: number,
 *   mrTitle?: string,
 *   mrUrl?: string,
 *   mrState?: string,
 *   note?: string,
 * }} PromotePlanStep
 *
 * @typedef {{
 *   flow?: 'promote' | 'guarantee',
 *   project: string,
 *   developBranch: string,
 *   productionBranch: string | null,
 *   dryRun: boolean,
 *   stopAfterFeature: boolean,
 *   stopAfterPromoteMr: boolean,
 *   skipBuildImage: boolean,
 *   waitFeaturePipeline: boolean,
 *   buildStage: string,
 *   steps: PromotePlanStep[],
 * }} PromotePlan
 */

/**
 * Анализ цепочки merge без выполнения: feature → develop → production.
 * @param {string} apiBaseUrl
 * @param {string} token
 * @param {PromoteOptions} options
 * @param {{ signal?: AbortSignal }} [hooks]
 * @returns {Promise<PromotePlan>}
 */
export async function planPromote(apiBaseUrl, token, options, hooks = {}) {
  const signal = hooks.signal;

  if (!token?.trim()) {
    throw new Error("Укажите Personal Access Token в настройках (нужен scope api)");
  }

  const refs = parseMrArgList(options.mrArg, options.mrBatch);
  const apiBase = apiRoot(apiBaseUrl);
  const dryRun = Boolean(options.dryRun);
  const stopAfterFeature = Boolean(options.stopAfterFeature);
  const stopAfterPromoteMr = Boolean(options.stopAfterPromoteMr);
  const skipBuildImage = Boolean(options.skipBuildImage);
  const waitFeaturePipeline = Boolean(options.waitFeaturePipeline);
  const buildStage = (options.buildStage || "build").trim();
  const branchRules = parseBranchMappings(options.branchMappings);

  checkAborted(signal);
  const batch = await loadAndValidateBatch(apiBase, token, refs, branchRules, signal);
  const { project, developBranch, mrs } = batch;
  const guaranteeDevelop = guaranteeDevelopBranch(developBranch, branchRules);
  if (guaranteeDevelop) {
    validateGuaranteeOverride(options, developBranch);
    checkAborted(signal);
    if (!dryRun && !(await branchExists(apiBase, token, project, guaranteeDevelop))) {
      throw new Error(`Ветка ${guaranteeDevelop} не найдена в ${project}`);
    }
    const steps = mrs.map(({ ref, mr }) => ({
      kind: "guarantee-merge",
      label: `Гарантия: merge !${ref.iid}`,
      sourceBranch: String(mr.source_branch), targetBranch: developBranch,
      mrIid: ref.iid, mrTitle: String(mr.title || ""),
      note: mr.state === "merged" ? "Уже влит, merge пропустится" :
        waitFeaturePipeline ? "Перед merge дождаться pipeline исходного MR" : undefined,
    }));
    if (!stopAfterFeature) {
      if (!skipBuildImage) steps.push({ kind: "build", label: "Сборка мастера", targetBranch: developBranch,
        note: `Выдать build-образ ${developBranch}. Выполняется параллельно с переносом в ${guaranteeDevelop}` });
      for (const { ref } of mrs) {
        steps.push({ kind: "cherry-pick", label: `Cherry-pick !${ref.iid}`,
          sourceBranch: developBranch, targetBranch: guaranteeDevelop,
          note: "После merge в мастер перенести доработку в отдельную ветку от develop и создать MR" });
        if (!stopAfterPromoteMr) steps.push({ kind: "backport", label: `Влить доработку !${ref.iid} в develop`,
          targetBranch: guaranteeDevelop, note: "Только после успешного pipeline cherry-pick MR" });
      }
    }
    return { flow: "guarantee", project, developBranch: guaranteeDevelop, productionBranch: developBranch,
      dryRun, stopAfterFeature, stopAfterPromoteMr, skipBuildImage, waitFeaturePipeline, buildStage, steps };
  }

  /** @type {string | null} */
  let productionBranch = null;
  if (!stopAfterFeature) {
    const productionOverride = options.productionBranch?.trim() || "";
    if (dryRun && !productionOverride) {
      productionBranch = productionCandidates(developBranch, branchRules).candidates[0];
    } else {
      productionBranch = await resolveProductionBranch(
        apiBase,
        token,
        project,
        developBranch,
        productionOverride || undefined,
        signal,
        branchRules
      );
    }
  }

  /** @type {PromotePlanStep[]} */
  const steps = [];

  for (let i = 0; i < mrs.length; i++) {
    const { ref, mr } = mrs[i];
    const state = String(mr.state || "");
    /** @type {string | undefined} */
    let note;
    if (state === "merged") note = "уже смержен — merge пропустится";
    else if (waitFeaturePipeline) note = "перед merge ждём pipeline feature MR";

    steps.push({
      kind: "feature",
      label:
        mrs.length > 1
          ? `Feature ${i + 1}/${mrs.length}: !${ref.iid}`
          : `Feature !${ref.iid}`,
      sourceBranch: String(mr.source_branch || ""),
      targetBranch: String(mr.target_branch || ""),
      mrIid: ref.iid,
      mrTitle: String(mr.title || ""),
      mrUrl: String(mr.web_url || ""),
      mrState: state,
      note,
    });
  }

  if (!stopAfterFeature && productionBranch) {
    steps.push({
      kind: "develop-build",
      label: "Сборка develop",
      targetBranch: developBranch,
      note: `Дождаться успешного pipeline на ${developBranch} после merge feature (без этого promote в production не выполняется)`,
    });
    if (stopAfterPromoteMr) {
      steps.push({
        kind: "promote-create",
        label: "Создать promote MR",
        sourceBranch: developBranch,
        targetBranch: productionBranch,
        note: "Остановка после создания — merge в production не выполняется",
      });
    } else {
      steps.push({
        kind: "promote",
        label: "Promote",
        sourceBranch: developBranch,
        targetBranch: productionBranch,
        note: "Создать promote MR (если нет) и смержить в production",
      });
      if (!skipBuildImage) {
        steps.push({
          kind: "build",
          label: "Build image",
          targetBranch: productionBranch,
          note: `Дождаться pipeline на ${productionBranch}, стадия «${buildStage}»`,
        });
      }
    }
  }

  return {
    project,
    developBranch,
    productionBranch,
    dryRun,
    stopAfterFeature,
    stopAfterPromoteMr,
    skipBuildImage,
    waitFeaturePipeline,
    buildStage,
    steps,
  };
}

/** Persist before moving to the next remote operation; never store credentials here. */
async function promoteCheckpoint(hooks, key, create) {
  const progress = hooks.progress ||= {};
  if (Object.hasOwn(progress, key)) return progress[key];
  const value = await create();
  progress[key] = value;
  await hooks.onProgress?.({ ...progress });
  return value;
}

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
  const branchRules = parseBranchMappings(options.branchMappings);

  log(`Параметры: timeout=${pipelineTimeout}s, poll=${pollSec}s, buildStage=${JSON.stringify(buildStage)}, ` +
    `dryRun=${dryRun}, waitFeaturePipeline=${Boolean(options.waitFeaturePipeline)}, ` +
    `skipBuildImage=${Boolean(options.skipBuildImage)}, stopAfterFeature=${Boolean(options.stopAfterFeature)}, ` +
    `stopAfterPromoteMr=${Boolean(options.stopAfterPromoteMr)}`);

  log(`Проект: ${refs[0].project}`);
  if (refs.length === 1) {
    log(`Feature MR: !${refs[0].iid}`);
  } else {
    log(`Feature MR (${refs.length}): ${refs.map((r) => `!${r.iid}`).join(", ")}`);
  }

  checkAborted(signal);
  const batch = await loadAndValidateBatch(apiBase, token, refs, branchRules, signal);
  const { project, developBranch, mrs } = batch;
  const guaranteeDevelop = guaranteeDevelopBranch(developBranch, branchRules);
  if (guaranteeDevelop) {
    validateGuaranteeOverride(options, developBranch);
    return runGuarantee(apiBase, token, batch, guaranteeDevelop, options, hooks);
  }

  let featureMr = mrs[mrs.length - 1].mr;

  for (const { ref, mr } of mrs) {
    log(`  загружен MR !${ref.iid}: ${formatMrSummary(mr)}`);
  }

  let productionBranch;
  const productionOverride = options.productionBranch?.trim() || "";
  if (dryRun && !productionOverride) {
    const { candidates } = productionCandidates(developBranch, branchRules);
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
      signal,
      branchRules
    );
  }

  log(`Develop:    ${developBranch}`);
  log(`Production: ${productionBranch}`);
  if (dryRun) log("--- dry run ---");

  const lastDevelopPipelineBeforeMerge = dryRun ? null : await promoteCheckpoint(hooks,
    "developBaseline", async () => {
      if (mrs.every(({ mr }) => mr.state === "merged")) return null;
      const pipelines = await listPipelinesForRef(apiBase, token, project, developBranch, { perPage: 1 });
      return pipelines.length ? Number(pipelines[0].id) : null;
    });
  let mergedAnyFeature = false;

  for (let i = 0; i < mrs.length; i++) {
    const { ref: mrRef } = mrs[i];
    const label =
      mrs.length > 1 ? `Feature ${i + 1}/${mrs.length}` : "Feature";

    checkAborted(signal);
    let mr = await refreshMergeRequest(apiBase, token, project, mrRef.iid, signal);
    const wasMerged = String(mr.state) === "merged";
    logMrSnapshot(log, `${label} перед обработкой`, mr);
    throwIfConflict(mr, label, hooks, log);
    ensureMergeable(mr, label, hooks, log);

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
    if (!wasMerged && String(mr.state) === "merged") {
      mergedAnyFeature = true;
    }
    if (mr.web_url) log(`${label}: ${mr.web_url}`);
    featureMr = mr;
  }

  if (options.stopAfterFeature) {
    log("Остановка после merge feature → develop.");
    return {};
  }

  // До promote в production develop с влитыми изменениями обязан собраться успешно.
  if (!dryRun && !hooks.progress?.promoteMrIid) {
    // Если feature уже были в develop — принимаем текущий success; иначе ждём
    // pipeline после baseline (push от merge).
    const afterDevelopId = lastDevelopPipelineBeforeMerge;
    log(
      `Ожидание успешного pipeline на ${JSON.stringify(developBranch)} ` +
        `перед promote в ${JSON.stringify(productionBranch)}…` +
        (mergedAnyFeature
          ? ` (после merge feature, baseline #${lastDevelopPipelineBeforeMerge ?? "—"})`
          : " (feature уже в develop — проверяем актуальный pipeline)")
    );
    const developPipelineId = await waitBranchPipeline(
      apiBase,
      token,
      project,
      developBranch,
      afterDevelopId,
      { timeoutSec: pipelineTimeout, pollSec, log, heartbeat, signal, dryRun, onPipelineState: hooks.onPipelineState }
    );
    log(
      `  develop pipeline готов: #${developPipelineId} — можно создавать/мержить promote MR`
    );
  } else if (dryRun) {
    log(
      `Dry run: пропуск ожидания pipeline ${JSON.stringify(developBranch)} перед promote`
    );
  }

  const pipelineCtx = { mrApiUnsupported: false, emptyPipelineOk: true };
  let promoteMr;
  if (dryRun) {
    promoteMr = await getOrCreatePromoteMr(apiBase, token, project, {
      developBranch, productionBranch, dryRun, log, signal, pipelineCtx,
    });
  } else {
    const iid = await promoteCheckpoint(hooks, "promoteMrIid", async () => {
      const mr = await getOrCreatePromoteMr(apiBase, token, project, {
        developBranch, productionBranch, dryRun, log, signal, pipelineCtx,
      });
      return Number(mr.iid);
    });
    promoteMr = await getMergeRequest(apiBase, token, project, iid);
    if (promoteMr.source_branch !== developBranch || promoteMr.target_branch !== productionBranch) {
      throw new Error(`Ветки promote MR !${iid} изменились. Повторите анализ.`);
    }
  }

  if (!dryRun) {
    checkAborted(signal);
    promoteMr = await getMergeRequest(apiBase, token, project, Number(promoteMr.iid));
  }
  log(`Promote MR: !${promoteMr.iid} (${promoteMr.web_url || ""})`);

  if (options.stopAfterPromoteMr) {
    log("Остановка после создания promote MR.");
    return {};
  }

  const lastPipelineBeforeMerge = dryRun ? null : await promoteCheckpoint(hooks,
    "productionBaseline", async () => {
      const pipelines = await listPipelinesForRef(apiBase, token, project, productionBranch, { perPage: 1 });
      return pipelines.length ? Number(pipelines[0].id) : null;
    });
  if (!dryRun && promoteMr.state !== "merged") {
    checkAborted(signal);

    const ensurePromotePipeline = () =>
      ensureMrPipelineStarted(apiBase, token, project, promoteMr, {
        dryRun,
        log,
        signal,
        pipelineCtx,
      });

    log("Ожидание pipeline promote MR…");
    logMrSnapshot(log, "promote MR", promoteMr);
    await ensurePromotePipeline();
    if (pipelineCtx.mrPipelineEmpty) {
      log("  CI не требует pipeline для promote MR (mrPipelineEmpty), продолжаем…");
    } else {
      const promotePipelineId = await waitPipelineLoop(
        async () => {
          const mrPipelines = await listMrPipelinesForSha(apiBase, token, project, promoteMr);
          const branchPipelines = await listPipelinesForRef(apiBase, token, project, developBranch);
          return [...mrPipelines, ...branchPipelines.filter(p => !promoteMr.sha || p.sha === promoteMr.sha)];
        },
        {
          timeoutSec: pipelineTimeout,
          pollSec,
          log,
          heartbeat,
          onPipelineState: hooks.onPipelineState,
          label: `MR pipeline !${promoteMr.iid}`,
          signal,
          onNoPipeline: ensurePromotePipeline,
          emptyPipelineOk: true,
          pipelineCtx,
        }
      );
      if (promotePipelineId != null) {
        log(`  promote MR pipeline завершён: #${promotePipelineId}`);
      }
    }
  }

  promoteMr = await mergeIfNeeded(apiBase, token, project, promoteMr, {
    dryRun,
    label: "Promote",
    verifiedSha: dryRun ? null : promoteMr.sha,
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
      { timeoutSec: pipelineTimeout, pollSec, log, heartbeat, signal, dryRun, onPipelineState: hooks.onPipelineState }
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
  { dryRun, label, waitPipelineBefore, pipelineTimeout, pollSec, log, heartbeat, signal, hooks, strictPipeline = false, verifiedSha = null }
) {
  const iid = Number(mr.iid);
  const expectedTarget = mr.target_branch;
  if (String(mr.state) === "merged") {
    log(`${label}: уже смержен (!${iid})`);
    return mr;
  }

  if (!dryRun) {
    mr = await refreshMergeRequest(apiBase, token, project, iid, signal);
  }
  if (mr.state === "merged") return mr;
  const checksDeadline = Date.now() + pipelineTimeout * 1000;
  let pipelineSha = verifiedSha;
  const checksPending = (value) =>
    [value.merge_status, value.detailed_merge_status].some(status =>
      ["checking", "unchecked", "preparing", "approvals_syncing"].includes(status));
  const validate = () => {
    if (pipelineSha && mr.sha !== pipelineSha) throw new Error(`Коммит MR !${iid} изменился после проверки pipeline. Повторите анализ.`);
    if (mr.target_branch !== expectedTarget) {
      throw new Error(`Target MR !${iid} изменился. Повторите анализ.`);
    }
    if (strictPipeline && !mr.sha) throw new Error(`MR !${iid}: отсутствует SHA для проверки pipeline`);
    ensureMergeable(mr, label, hooks, log);
  };
  const waitForChecks = async () => {
    validate();
    while (!dryRun && mr.state !== "merged" && checksPending(mr)) {
      checkAborted(signal);
      if (Date.now() >= checksDeadline) {
        throw new Error(`${label} MR !${iid}: проверка возможности слияния не завершилась за ${pipelineTimeout} с`);
      }
      await heartbeat?.();
      await sleep(pollSec * 1000, signal);
      mr = await refreshMergeRequest(apiBase, token, project, iid, signal);
      validate();
    }
  };
  await waitForChecks();
  if (mr.state === "merged") return mr;

  if (waitPipelineBefore) {
    log(`${label}: ожидание pipeline перед merge (!${iid})…`);
    if (!dryRun) {
      const pipelineCtx = { mrApiUnsupported: false };
      const ensurePipeline = () =>
        ensureMrPipelineStarted(apiBase, token, project, mr, {
          dryRun,
          log,
          signal,
          pipelineCtx,
        });
      await ensurePipeline();
      await waitPipelineLoop(async () => {
        const mrPipelines = await listMrPipelinesForSha(apiBase, token, project, mr);
        const branchPipelines = await listPipelinesForRef(apiBase, token, project, String(mr.source_branch));
        return [...mrPipelines, ...branchPipelines.filter(p => !mr.sha || p.sha === mr.sha)];
      }, {
        timeoutSec: pipelineTimeout,
        pollSec,
        log,
        heartbeat,
        onPipelineState: hooks.onPipelineState,
        label: `MR pipeline !${iid}`,
        signal,
        onNoPipeline: ensurePipeline,
      });
    }
  }

  if (waitPipelineBefore && !dryRun) {
    pipelineSha = mr.sha;
    mr = await refreshMergeRequest(apiBase, token, project, iid, signal);
    await waitForChecks();
    if (mr.state === "merged") return mr;
  }

  log(
    `${label}: merge !${iid} (${mr.source_branch} → ${mr.target_branch}), ` +
      "should_remove_source_branch=false"
  );
  logMrSnapshot(log, `${label} перед merge`, mr);
  if (dryRun) return mr;

  while (true) {
    checkAborted(signal);
    try {
      return await mergeMergeRequest(apiBase, token, project, iid, strictPipeline || waitPipelineBefore || verifiedSha ? String(mr.sha) : undefined);
    } catch (err) {
      const msg = formatError(err);
      checkAborted(signal);
      log(`  [merge API] ошибка: ${msg}`);
      const fresh = await refreshMergeRequest(apiBase, token, project, iid, signal);
      logMrSnapshot(log, `${label} после ошибки merge`, fresh);
      if (fresh.state === "merged") return fresh;
      if (/\b405\b/.test(msg) && checksPending(fresh)) {
        mr = fresh;
        await waitForChecks();
        if (mr.state === "merged") return mr;
        continue;
      }
      const mrPipelines = await listMrPipelines(apiBase, token, project, iid);
      logPipelinesSnapshot(log, `MR !${iid}`, mrPipelines);
      throw new Error(
        `${label} merge !${iid} failed: ${msg} | MR: ${formatMrSummary(fresh)} | ` +
          `pipelines: ${formatPipelinesSummary(mrPipelines)}`
      );
    }
  }
}

async function getOrCreatePromoteMr(
  apiBase,
  token,
  project,
  { developBranch, productionBranch, dryRun, log, signal, pipelineCtx = null }
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
    logMrSnapshot(log, "существующий promote MR", mr);
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
  await waitForMrAutoPipeline(apiBase, token, project, mr, {
    log,
    signal,
    pipelineCtx: pipelineCtx || {},
  });
  return mr;
}

function validateGuaranteeOverride(options, productionBranch) {
  if (options.productionBranch?.trim() && options.productionBranch.trim() !== productionBranch) {
    throw new Error(`Флоу «Гарантия» использует target исходного MR: ${productionBranch}. Очистите поле production-ветки.`);
  }
}

/** Pick the complete MR changes, including squash and fast-forward merges. */
async function guaranteeCommits(apiBase, token, project, mr, signal) {
  checkAborted(signal);
  if (mr.squash_commit_sha) return [String(mr.squash_commit_sha)];
  if (mr.merge_commit_sha) {
    const commit = await getCommit(apiBase, token, project, String(mr.merge_commit_sha));
    if (commit.parent_ids?.length > 1) return [String(mr.merge_commit_sha)];
  }
  checkAborted(signal);
  const commits = await listMrCommits(apiBase, token, project, Number(mr.iid));
  if (!commits.length) throw new Error(`Не найдены коммиты влитого MR !${mr.iid}`);
  // Follow the first-parent chain: a merge commit already contains its side
  // branch changes, so picking those commits again would duplicate the patch.
  const byId = new Map(commits.map(c => [c.id, c]));
  let commit = byId.get(mr.merge_commit_sha || mr.sha);
  if (!commit) throw new Error(`Не найден итоговый коммит MR !${mr.iid} для cherry-pick`);
  const ordered = [];
  while (commit) {
    ordered.push(String(commit.id));
    commit = byId.get(commit.parent_ids?.[0]);
  }
  return ordered.reverse();
}

async function runGuarantee(apiBase, token, batch, developBranch, options, hooks) {
  const { project, developBranch: productionBranch, mrs } = batch;
  const { signal, log = () => {}, heartbeat } = hooks;
  const dryRun = Boolean(options.dryRun);
  const pipelineTimeout = options.pipelineTimeoutSec ?? 7200;
  const pollSec = options.pollIntervalSec ?? 20;
  const buildStage = (options.buildStage || "build").trim();
  log(`Флоу: Гарантия. ${productionBranch} → cherry-pick → ${developBranch}`);
  checkAborted(signal);
  if (!dryRun && !(await branchExists(apiBase, token, project, developBranch))) {
    throw new Error(`Ветка ${developBranch} не найдена в ${project}`);
  }
  const baseline = dryRun || options.skipBuildImage || options.stopAfterFeature ? null
    : await promoteCheckpoint(hooks, "guaranteeBaseline", async () => {
      if (mrs.every(({ mr }) => mr.state === "merged")) return null;
      const pipelines = await listPipelinesForRef(apiBase, token, project, productionBranch, { perPage: 1 });
      return pipelines.length ? Number(pipelines[0].id) : null;
    });
  const mergedMrs = [];
  for (const { ref } of mrs) {
    let mr = await refreshMergeRequest(apiBase, token, project, ref.iid, signal);
    if (mr.target_branch !== productionBranch) throw new Error(`Target MR !${ref.iid} изменился. Повторите анализ.`);
    mr = await mergeIfNeeded(apiBase, token, project, mr, {
      dryRun, label: "Гарантия", waitPipelineBefore: Boolean(options.waitFeaturePipeline),
      pipelineTimeout, pollSec, log, heartbeat, signal, hooks,
    });
    if (!dryRun) {
      mr = await refreshMergeRequest(apiBase, token, project, ref.iid, signal);
      if (mr.state !== "merged") throw new Error(`MR !${ref.iid} ещё не влит в ${productionBranch}`);
    }
    mergedMrs.push(mr);
  }
  if (options.stopAfterFeature) {
    log(`Остановка после merge в ${productionBranch}.`);
    return {};
  }

  const build = async () => {
    if (dryRun || options.skipBuildImage) {
      log(`Сборка ${productionBranch}: ожидание образа пропущено.`);
      return undefined;
    }
    const expectedSha = await promoteCheckpoint(hooks, "guaranteeBuildSha", async () => {
      const commit = await getCommit(apiBase, token, project, productionBranch);
      if (!commit.id) throw new Error(`Не найден коммит ветки ${productionBranch}`);
      return String(commit.id);
    });
    const pipelineId = await waitBranchPipeline(apiBase, token, project, productionBranch,
      baseline,
      { timeoutSec: pipelineTimeout, pollSec, log, heartbeat, signal, dryRun, expectedSha, onPipelineState: hooks.onPipelineState });
    const image = await extractBuildImage(apiBase, token, project, pipelineId, buildStage, log, signal);
    log(`Build image: ${image}`);
    await hooks.onBuildImage?.(image);
    return image;
  };
  const backport = async () => {
    for (const mr of mergedMrs) {
      checkAborted(signal);
      const sourceBranch = `guarantee/mr-${mr.iid}-${String(mr.squash_commit_sha || mr.merge_commit_sha || mr.sha).slice(0, 12)}`;
      log(`Гарантия !${mr.iid}: cherry-pick в ${sourceBranch} → ${developBranch}`);
      if (dryRun) {
        log(`Dry run: создать ветку от ${developBranch}, cherry-pick, создать MR${options.stopAfterPromoteMr ? "" : ", дождаться успешного pipeline и влить"}.`);
        continue;
      }
      const existing = await listBackportMergeRequests(apiBase, token, project, sourceBranch, developBranch);
      let backportMr = existing.find(item => item.state === "merged") || existing.find(item => item.state === "opened");
      if (!backportMr) {
        checkAborted(signal);
        if (await branchExists(apiBase, token, project, sourceBranch)) {
          throw new Error(`Ветка ${sourceBranch} уже существует без открытого/влитого MR. Проверьте незавершённый cherry-pick вручную.`);
        }
        const commits = await guaranteeCommits(apiBase, token, project, mr, signal);
        checkAborted(signal);
        await createBranch(apiBase, token, project, sourceBranch, developBranch);
        for (const sha of commits) {
          checkAborted(signal);
          try {
            await cherryPickCommit(apiBase, token, project, sha, sourceBranch);
          } catch (err) {
            throw new Error(`Cherry-pick !${mr.iid} (${sha}) в ${sourceBranch} не выполнен: ${formatError(err)}. Мастер уже влит; проверьте ветку вручную.`);
          }
        }
        checkAborted(signal);
        backportMr = await createMergeRequest(apiBase, token, project, {
          sourceBranch, targetBranch: developBranch, title: `Гарантия !${mr.iid}: ${mr.title || mr.source_branch}`,
        });
      }
      log(`Гарантия: MR !${backportMr.iid} ${backportMr.web_url || ""}`);
      if (options.stopAfterPromoteMr || backportMr.state === "merged") continue;
      // A successful pipeline is mandatory; an empty/skipped MR pipeline is not accepted.
      await mergeIfNeeded(apiBase, token, project, backportMr, {
        dryRun, label: "Гарантия cherry-pick", waitPipelineBefore: true, strictPipeline: true,
        pipelineTimeout, pollSec, log, heartbeat, signal, hooks,
      });
    }
  };
  // Wait for both outcomes so a cherry-pick failure cannot suppress the master image.
  const [buildResult, backportResult] = await Promise.allSettled([build(), backport()]);
  const errors = [buildResult, backportResult].filter(result => result.status === "rejected");
  if (errors.length) {
    if (signal?.aborted) checkAborted(signal);
    throw new Error(errors.map(result => formatError(result.reason)).join("; "));
  }
  log("Гарантия: готово.");
  return { buildImage: buildResult.value };
}
