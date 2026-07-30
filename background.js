import {
  apiRoot,
  getMergeRequest,
  getLatestMrPipeline,
  getPipelineJob,
  listPipelineJobs,
} from "./gitlab-api.js";
import { deliverCiNotification } from "./ci-notify.js";
import { DEFAULT_BRANCH_MAPPINGS } from "./gitlab-promote.js";
import {
  acceptPromoteStart,
  cancelPromoteRun,
  dismissPromoteSession,
  getActivePromoteSession,
  getPromoteSession,
  listPromoteSessions,
  previewPromotePlan,
  PROMOTE_KEEPALIVE_ALARM,
  promoteKeepaliveTick,
  reconcileStalePromoteSession,
  resetPromoteSession,
  setActivePromoteSession,
} from "./promote-runner.js";

reconcileStalePromoteSession().catch((e) =>
  console.warn("[gitlab-notifier] promote reconcile", e)
);

const ALARM = "gitlab-ci-poll";

const RUNNING = new Set([
  "created",
  "pending",
  "running",
  "waiting_for_resource",
  "preparing",
  "manual",
  "scheduled",
  "playing",
  "canceling",
]);

const TERMINAL_SUCCESS = new Set(["success"]);
const TERMINAL_FAIL = new Set(["failed"]);
const TERMINAL_SKIP = new Set(["skipped"]);

function parseGitLabUrl(tabUrl) {
  try {
    const u = new URL(tabUrl);
    const path = u.pathname.replace(/\/+$/, "");
    /* Не якорим $: бывают …/pipelines/123/graph, …/pipelines/123/failures и т.д. */
    const pl = path.match(/^(.+)\/-\/pipelines\/(\d+)/);
    if (pl) {
      const projectPath = pl[1].replace(/^\//, "");
      return {
        origin: u.origin,
        projectPath,
        pipelineId: Number(pl[2], 10),
        kind: "pipeline",
      };
    }
    const mr = path.match(/^(.+)\/-\/merge_requests\/(\d+)/);
    if (mr) {
      const projectPath = mr[1].replace(/^\//, "");
      return {
        origin: u.origin,
        projectPath,
        mrIid: Number(mr[2], 10),
        kind: "mr",
      };
    }
    /* Логи джоба: …/-/jobs/:id — иначе вкладка не попадала в опрос */
    const job = path.match(/^(.+)\/-\/jobs\/(\d+)/);
    if (job) {
      const projectPath = job[1].replace(/^\//, "");
      return {
        origin: u.origin,
        projectPath,
        jobId: Number(job[2], 10),
        kind: "job",
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function notifyKey(origin, projectPath, pipelineId, stageName) {
  return `${origin}|${projectPath}|${pipelineId}|${stageName}`;
}

/** @param {number} tabId @param {string} nk */
function tabPhaseStorageKey(tabId, nk) {
  return `tabStagePhase:${tabId}\n${nk}`;
}

async function loadSettings() {
  const d = await chrome.storage.local.get({
    gitlabBaseUrl: "https://git-02.t1-group.ru",
    privateToken: "",
    stageName: "build",
    pollIntervalSec: 25,
    treatSkippedAsSuccess: true,
    treatCanceledAsFailure: true,
    enableOverlay: false,
    enableFaviconTint: true,
    enableNotificationSound: true,
    projectWhitelist: "",
  });
  return d;
}

async function getNotifiedSet() {
  const { notified = {} } = await chrome.storage.local.get("notified");
  return notified;
}

async function markNotified(key) {
  const { notified = {} } = await chrome.storage.local.get("notified");
  notified[key] = Date.now();
  await chrome.storage.local.set({ notified });
}

function projectAllowed(projectPath, whitelistRaw) {
  const t = String(whitelistRaw || "").trim();
  if (!t) return true;
  const lines = t
    .split(/[\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return lines.some((prefix) => projectPath === prefix || projectPath.startsWith(prefix + "/"));
}

function normalizeJobStatus(status) {
  const s = String(status || "")
    .trim()
    .toLowerCase();
  return s === "cancelled" ? "canceled" : s;
}

/**
 * Время «завершения» стадии для эвристики свежести: GitLab не всегда даёт `finished_at` вовремя;
 * `updated_at` у failed-джоба обычно есть.
 */
function latestStageRelevantTsMs(jobsInStage) {
  let max = null;
  for (const j of jobsInStage) {
    for (const field of ["finished_at", "updated_at"]) {
      const raw = j && j[field];
      if (typeof raw !== "string") continue;
      const t = Date.parse(raw);
      if (Number.isNaN(t)) continue;
      max = max === null ? t : Math.max(max, t);
    }
  }
  return max;
}

function aggregateStage(jobsInStage, settings) {
  if (!jobsInStage.length) {
    return { phase: "empty" };
  }
  /** @type {string[]} */
  const statuses = [];
  for (const j of jobsInStage) {
    statuses.push(normalizeJobStatus(j.status));
  }

  /* Любой failed в stage — финал с ошибкой (fail-fast GitLab), даже если рядом manual/pending */
  if (statuses.some((st) => TERMINAL_FAIL.has(st))) {
    return { phase: "done", ok: false };
  }

  if (statuses.some((st) => RUNNING.has(st))) {
    return { phase: "running" };
  }

  let hasCanceled = false;
  for (const st of statuses) {
    if (st === "canceled") hasCanceled = true;
  }
  if (hasCanceled && settings.treatCanceledAsFailure) {
    return { phase: "done", ok: false };
  }
  for (const st of statuses) {
    if (TERMINAL_SKIP.has(st) && !settings.treatSkippedAsSuccess) {
      return { phase: "done", ok: false };
    }
  }
  const allGreen = statuses.every(
    (st) =>
      TERMINAL_SUCCESS.has(st) ||
      (TERMINAL_SKIP.has(st) && settings.treatSkippedAsSuccess),
  );
  if (allGreen) return { phase: "done", ok: true };
  /** unexpected status */
  return { phase: "done", ok: false };
}

async function resolvePipelineId(parsed, settings) {
  const base = settings.gitlabBaseUrl.replace(/\/$/, "");
  if (parsed.origin !== new URL(base).origin) {
    return null;
  }
  const apiBase = apiRoot(base);
  if (parsed.kind === "pipeline") return parsed.pipelineId;
  if (parsed.kind === "job") {
    const row = await getPipelineJob(
      apiBase,
      settings.privateToken,
      parsed.projectPath,
      parsed.jobId,
    );
    const p = row && row.pipeline;
    if (p && typeof p.id === "number") return p.id;
    return null;
  }
  const mr = await getMergeRequest(apiBase, settings.privateToken, parsed.projectPath, parsed.mrIid);
  const hp = mr && mr.head_pipeline;
  if (hp && typeof hp.id === "number") return hp.id;
  const latest = await getLatestMrPipeline(apiBase, settings.privateToken, parsed.projectPath, parsed.mrIid);
  if (latest && typeof latest.id === "number") return latest.id;
  return null;
}

async function runPoll() {
  const settings = await loadSettings();
  const base = settings.gitlabBaseUrl.replace(/\/$/, "");
  let apiBase;
  try {
    apiBase = apiRoot(base);
  } catch {
    return;
  }
  const stageName = String(settings.stageName || "build").trim() || "build";

  const tabs = await chrome.tabs.query({});
  /** @type {Map<string, { origin: string, projectPath: string, pipelineId: number, tabIds: number[] }>} */
  const byPipeline = new Map();

  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    const parsed = parseGitLabUrl(tab.url);
    if (!parsed) continue;
    if (parsed.origin !== new URL(base).origin) continue;
    if (!projectAllowed(parsed.projectPath, settings.projectWhitelist)) continue;

    let pipelineId;
    try {
      pipelineId = await resolvePipelineId(parsed, settings);
    } catch (e) {
      console.warn("[gitlab-notifier] resolve pipeline:", e);
      continue;
    }
    if (pipelineId == null) continue;

    const k = `${parsed.origin}\n${parsed.projectPath}\n${pipelineId}`;
    const cur = byPipeline.get(k);
    if (cur) {
      cur.tabIds.push(tab.id);
    } else {
      byPipeline.set(k, {
        origin: parsed.origin,
        projectPath: parsed.projectPath,
        pipelineId,
        tabIds: [tab.id],
      });
    }
  }

  const notified = await getNotifiedSet();

  for (const { origin, projectPath, pipelineId, tabIds } of byPipeline.values()) {
    const nk = notifyKey(origin, projectPath, pipelineId, stageName);
    if (notified[nk]) continue;

    let jobs;
    try {
      jobs = await listPipelineJobs(apiBase, settings.privateToken, projectPath, pipelineId);
    } catch (e) {
      console.warn("[gitlab-notifier] jobs:", e);
      continue;
    }

    const stageKey = stageName.toLowerCase();
    const inStage = jobs.filter(
      (j) => String(j.stage || "").trim().toLowerCase() === stageKey,
    );
    const agg = aggregateStage(inStage, settings);

    const phaseKeys = tabIds.map((id) => tabPhaseStorageKey(id, nk));
    const prevByKey = await chrome.storage.session.get(phaseKeys);

    let shouldNotify = false;
    for (let i = 0; i < tabIds.length; i += 1) {
      const prev = prevByKey[phaseKeys[i]];
      if (prev !== undefined && prev !== "done" && agg.phase === "done") {
        shouldNotify = true;
        break;
      }
    }
    /*
     * Первый опрос уже terminal «done» без prev — transition не был.
     * Ошибка стадии: всегда оповещать (дедуп по notified). Успех: только «свежий» по времени джобов.
     */
    if (!shouldNotify && agg.phase === "done") {
      const sawNonTerminal = tabIds.some((_, i) => {
        const prev = prevByKey[phaseKeys[i]];
        return prev !== undefined && prev !== "done";
      });
      if (!sawNonTerminal) {
        if (!agg.ok) {
          shouldNotify = true;
        } else {
          const ts = latestStageRelevantTsMs(inStage);
          const pollMs = Math.max(10, Number(settings.pollIntervalSec) || 25) * 1000;
          const freshMs = Math.max(15 * 60 * 1000, pollMs * 6);
          if (ts !== null && Date.now() - ts <= freshMs) {
            shouldNotify = true;
          }
        }
      }
    }

    await chrome.storage.session.set(
      Object.fromEntries(phaseKeys.map((key) => [key, agg.phase])),
    );

    if (agg.phase !== "done" || !shouldNotify) continue;

    const ok = agg.ok;
    await markNotified(nk);

    const label = ok ? "CI: build OK" : "CI: build failed";
    const body = `${projectPath} · pipeline #${pipelineId} · stage «${stageName}»`;
    const notifId = `n_${projectPath.replace(/\W/g, "_")}_${pipelineId}_${stageName.replace(/\W+/g, "_")}`.slice(0, 120);
    await deliverCiNotification(tabIds, settings, {
      ok,
      title: label,
      message: body,
      notifId,
    });
  }
}

function scheduleAlarm(delaySec) {
  const sec = Math.max(10, Math.min(600, Number(delaySec) || 25));
  const delayMinutes = sec / 60;
  chrome.alarms.create(ALARM, { delayInMinutes: delayMinutes });
}

function clearExtensionActionBadge() {
  chrome.action.setBadgeText({ text: "" });
}

chrome.runtime.onInstalled.addListener(() => {
  clearExtensionActionBadge();
  loadSettings().then((s) => {
    scheduleAlarm(s.pollIntervalSec);
    runPoll().catch(() => {});
  });
});

chrome.runtime.onStartup.addListener(() => {
  clearExtensionActionBadge();
  loadSettings().then((s) => {
    scheduleAlarm(s.pollIntervalSec);
    runPoll().catch(() => {});
  });
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === PROMOTE_KEEPALIVE_ALARM) {
    promoteKeepaliveTick().catch((e) => console.warn("[gitlab-notifier] promote keepalive", e));
    return;
  }
  if (a.name !== ALARM) return;
  runPoll()
    .catch((e) => console.warn("[gitlab-notifier] poll", e))
    .finally(() => {
      loadSettings().then((s) => scheduleAlarm(s.pollIntervalSec));
    });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.pollIntervalSec) {
    loadSettings().then((s) => {
      chrome.alarms.clear(ALARM);
      scheduleAlarm(s.pollIntervalSec);
    });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab?.url) return;
  if (
    !tab.url.includes("/-/merge_requests/") &&
    !tab.url.includes("/-/pipelines/") &&
    !tab.url.includes("/-/jobs/")
  ) {
    return;
  }
  loadSettings().then((s) => scheduleAlarm(Math.min(20, s.pollIntervalSec)));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const prefix = `tabStagePhase:${tabId}\n`;
  chrome.storage.session.get(null).then((all) => {
    const toRemove = Object.keys(all).filter((k) => k.startsWith(prefix));
    if (toRemove.length) chrome.storage.session.remove(toRemove);
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;

  if (msg.type === "promote-get-sessions") {
    reconcileStalePromoteSession()
      .then(async () => {
        const sessions = await listPromoteSessions();
        const { state } = await getActivePromoteSession();
        sendResponse({ ok: true, sessions, activeId: state.activeId });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === "promote-get-session") {
    reconcileStalePromoteSession()
      .then((session) => sendResponse({ ok: true, session }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === "promote-set-active") {
    setActivePromoteSession(msg.sessionId)
      .then((session) => sendResponse({ ok: true, session }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === "promote-dismiss") {
    dismissPromoteSession(msg.sessionId)
      .then((activeId) => sendResponse({ ok: true, activeId }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg.type === "promote-plan") {
    (async () => {
      try {
        const settings = await chrome.storage.local.get({
          gitlabBaseUrl: "https://git-02.t1-group.ru",
          privateToken: "",
          promoteBranchMappings: DEFAULT_BRANCH_MAPPINGS,
        });
        if (!settings.privateToken) {
          sendResponse({ ok: false, error: "Нет токена в настройках" });
          return;
        }
        const form = {
          ...msg.form,
          branchMappings: settings.promoteBranchMappings,
        };
        const plan = await previewPromotePlan(form, {
          gitlabBaseUrl: settings.gitlabBaseUrl,
          privateToken: settings.privateToken,
        });
        sendResponse({ ok: true, plan });
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  }

  if (msg.type === "promote-start") {
    (async () => {
      try {
        const settings = await chrome.storage.local.get({
          gitlabBaseUrl: "https://git-02.t1-group.ru",
          privateToken: "",
          promoteBranchMappings: DEFAULT_BRANCH_MAPPINGS,
        });
        if (!settings.privateToken) {
          sendResponse({ ok: false, error: "Нет токена в настройках" });
          return;
        }
        const form = {
          ...msg.form,
          branchMappings: settings.promoteBranchMappings,
        };
        const result = await acceptPromoteStart(form, {
          gitlabBaseUrl: settings.gitlabBaseUrl,
          privateToken: settings.privateToken,
        });
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  }

  if (msg.type === "promote-cancel") {
    cancelPromoteRun(msg.sessionId);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "promote-reset") {
    resetPromoteSession()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
});
