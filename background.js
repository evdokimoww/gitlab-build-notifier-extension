import {
  apiRoot,
  getMergeRequest,
  getLatestMrPipeline,
  getPipelineJob,
  listPipelineJobs,
} from "./gitlab-api.js";

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

/**
 * Звук в фоне: в service worker нет Audio — используем offscreen; при ошибке — вкладка GitLab.
 * @param {number[]} tabIds
 * @param {boolean} success — true: notify.wav, false: notify-fail.wav
 */
async function playNotificationSound(tabIds, success) {
  const soundSrc = chrome.runtime.getURL(
    success ? "sounds/notify.wav" : "sounds/notify-fail.wav",
  );
  try {
    if (chrome.offscreen?.createDocument) {
      try {
        await chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["AUDIO_PLAYBACK"],
          justification:
            "Воспроизведение звука при завершении stage CI GitLab (уведомление пользователя).",
        });
      } catch {
        /* документ offscreen уже создан */
      }
      chrome.runtime.sendMessage({
        type: "PLAY_GITLAB_CI_SOUND",
        soundUrl: soundSrc,
      });
      return;
    }
  } catch (e) {
    console.warn("[gitlab-notifier] offscreen sound:", e);
  }
  if (!tabIds.length) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabIds[0] },
      func: (src) => {
        const a = new Audio(src);
        a.volume = 0.4;
        a.play().catch(() => {});
      },
      args: [soundSrc],
    });
  } catch (e) {
    console.warn("[gitlab-notifier] sound через вкладку:", e);
  }
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

    if (agg.phase === "empty" || agg.phase === "running") continue;
    if (agg.phase !== "done") continue;

    const ok = agg.ok;
    await markNotified(nk);

    const label = ok ? "CI: build OK" : "CI: build failed";
    const body = `${projectPath} · pipeline #${pipelineId} · stage «${stageName}»`;
    const notifId = `n_${projectPath.replace(/\W/g, "_")}_${pipelineId}_${stageName.replace(/\W+/g, "_")}`.slice(0, 120);
    const iconUrl = chrome.runtime.getURL(
      ok ? "icons/notify-ok.png" : "icons/notify-fail.png",
    );

    const permission = await new Promise((resolve) => {
      if (chrome.notifications.getPermissionLevel) {
        chrome.notifications.getPermissionLevel(resolve);
      } else {
        resolve("granted");
      }
    });
    if (permission !== "granted") {
      console.warn("[gitlab-notifier] уведомления браузера недоступны (уровень:", permission + "). Проверьте настройки уведомлений для Chrome в системе.");
    }

    await chrome.notifications.clear(notifId).catch(() => {});

    try {
      await chrome.notifications.create(notifId, {
        type: "basic",
        iconUrl,
        title: label,
        message: body,
        priority: 2,
      });
    } catch (e) {
      console.error("[gitlab-notifier] chrome.notifications.create:", e);
      try {
        await chrome.notifications.create({
          type: "basic",
          iconUrl,
          title: label,
          message: body,
        });
      } catch (e2) {
        console.error("[gitlab-notifier] повторное создание уведомления:", e2);
      }
    }

    if (settings.enableNotificationSound !== false) {
      await playNotificationSound(tabIds, ok).catch((e) =>
        console.warn("[gitlab-notifier] play sound:", e),
      );
    }

    await chrome.action.setBadgeText({ text: ok ? "V" : "X" });
    await chrome.action.setBadgeBackgroundColor({ color: ok ? "#0d8050" : "#c03131" });

    for (const tabId of tabIds) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: applyTabFeedback,
          args: [
            ok,
            {
              enableOverlay: settings.enableOverlay,
              enableFaviconTint: settings.enableFaviconTint !== false,
            },
          ],
        });
      } catch (e) {
        console.warn("[gitlab-notifier] tab script:", e);
      }
    }
  }
}

/**
 * Runs in page context via executeScript
 * @param {boolean} ok
 * @param {{ enableOverlay?: boolean, enableFaviconTint?: boolean }} tabFeedback
 */
function applyTabFeedback(ok, tabFeedback) {
  const enableOverlay = tabFeedback && tabFeedback.enableOverlay;
  const enableFaviconTint = !tabFeedback || tabFeedback.enableFaviconTint !== false;

  const prefix = ok ? "[CI OK]" : "[CI FAIL]";
  const t = document.title.replace(/^\[(CI OK|CI FAIL|CI …)\]\s*/, "");
  document.title = `${prefix} ${t}`;

  if (enableFaviconTint) {
    const size = 32;
    const fill = ok ? "#0d8050" : "#c03131";
    const fid = "__gitlab_ci_notifier_favicon__";
    const timerKey = "__gitlab_ci_notifier_favicon_iv__";

    /** @param {number} opacity 0..1 */
    function circleDataUrl(opacity) {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const c = canvas.getContext("2d");
      if (!c) return "";
      c.clearRect(0, 0, size, size);
      c.globalAlpha = opacity;
      c.fillStyle = fill;
      c.beginPath();
      c.arc(size / 2, size / 2, size / 2 - 0.5, 0, Math.PI * 2);
      c.fill();
      return canvas.toDataURL("image/png");
    }

    const strongUrl = circleDataUrl(1);
    const softUrl = circleDataUrl(0.28);

    /** Первый «родной» favicon, не наш — для чередования при мигании */
    let nativeIconHref = "";
    try {
      for (const el of document.querySelectorAll('link[rel~="icon"], link[rel~="shortcut icon"]')) {
        if (el.id === fid) continue;
        const raw = el.getAttribute("href");
        if (!raw) continue;
        nativeIconHref = new URL(raw, document.baseURI).href;
        break;
      }
    } catch {
      nativeIconHref = "";
    }

    let link = document.getElementById(fid);
    if (!link) {
      link = document.createElement("link");
      link.id = fid;
      link.rel = "icon";
      link.type = "image/png";
      document.head.appendChild(link);
    }

    const prev = window[timerKey];
    if (typeof prev === "number") {
      window.clearInterval(prev);
    }

    let blinkOn = true;
    let ticks = 0;
    const blinkMs = 450;
    const maxTicks = 28; /* ~12.6 с, потом оставляем яркий кружок */

    function showFrame() {
      if (nativeIconHref) {
        link.href = blinkOn ? strongUrl : nativeIconHref;
      } else {
        link.href = blinkOn ? strongUrl : softUrl;
      }
      blinkOn = !blinkOn;
      ticks += 1;
      if (ticks >= maxTicks) {
        window.clearInterval(window[timerKey]);
        window[timerKey] = 0;
        link.href = strongUrl;
      }
    }

    showFrame();
    window[timerKey] = window.setInterval(showFrame, blinkMs);
  }

  if (!enableOverlay) return;

  const id = "__gitlab_ci_notifier_bar__";
  let bar = document.getElementById(id);
  if (!bar) {
    bar = document.createElement("div");
    bar.id = id;
    bar.style.cssText = [
      "position:fixed",
      "top:0",
      "left:0",
      "right:0",
      "height:4px",
      "z-index:2147483647",
      "pointer-events:none",
      "transition:opacity 0.4s ease",
    ].join(";");
    document.documentElement.appendChild(bar);
  }
  bar.style.background = ok ? "#0d8050" : "#c03131";
  bar.style.opacity = "1";
  let on = true;
  const iv = window.setInterval(() => {
    on = !on;
    bar.style.opacity = on ? "1" : "0.35";
  }, 600);
  window.setTimeout(() => {
    window.clearInterval(iv);
    bar.style.opacity = "1";
  }, 8000);
}

function scheduleAlarm(delaySec) {
  const sec = Math.max(10, Math.min(600, Number(delaySec) || 25));
  const delayMinutes = sec / 60;
  chrome.alarms.create(ALARM, { delayInMinutes: delayMinutes });
}

chrome.runtime.onInstalled.addListener(() => {
  loadSettings().then((s) => {
    scheduleAlarm(s.pollIntervalSec);
    runPoll().catch(() => {});
  });
});

chrome.runtime.onStartup.addListener(() => {
  loadSettings().then((s) => {
    scheduleAlarm(s.pollIntervalSec);
    runPoll().catch(() => {});
  });
});

chrome.alarms.onAlarm.addListener((a) => {
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
