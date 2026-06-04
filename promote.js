import { runPromote } from "./gitlab-promote.js";

const STORAGE_KEYS = {
  mrArg: "promoteMrArg",
  productionBranch: "promoteProductionBranch",
  dryRun: "promoteDryRun",
  waitFeaturePipeline: "promoteWaitFeaturePipeline",
  stopAfterFeature: "promoteStopAfterFeature",
  stopAfterPromoteMr: "promoteStopAfterPromoteMr",
  skipBuildImage: "promoteSkipBuildImage",
  buildStage: "promoteBuildStage",
  pipelineTimeout: "promotePipelineTimeout",
  pollInterval: "promotePollInterval",
};

/** @type {AbortController | null} */
let abortController = null;

function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id}`);
  return el;
}

function setStatus(text, kind) {
  const p = $("statusLine");
  p.textContent = text;
  p.className = kind === "ok" ? "ok" : kind === "err" ? "err" : kind === "warn" ? "warn" : "";
}

function appendLog(line) {
  const el = $("log");
  el.textContent += (el.textContent ? "\n" : "") + line;
  el.scrollTop = el.scrollHeight;
}

function setRunning(running) {
  $("run").disabled = running;
  $("cancel").disabled = !running;
  $("mrArg").disabled = running;
}

async function ensureHostPermission(gitlabBaseUrl) {
  const u = new URL(gitlabBaseUrl);
  const originPat = `${u.origin}/*`;
  const has = await chrome.permissions.contains({ origins: [originPat] });
  if (has) return true;
  return chrome.permissions.request({ origins: [originPat] });
}

function readForm() {
  return {
    mrArg: $("mrArg").value.trim(),
    productionBranch: $("productionBranch").value.trim(),
    dryRun: $("dryRun").checked,
    waitFeaturePipeline: $("waitFeaturePipeline").checked,
    stopAfterFeature: $("stopAfterFeature").checked,
    stopAfterPromoteMr: $("stopAfterPromoteMr").checked,
    skipBuildImage: $("skipBuildImage").checked,
    buildStage: $("buildStage").value.trim() || "build",
    pipelineTimeoutSec: Math.min(
      86400,
      Math.max(60, Number($("pipelineTimeout").value) || 7200)
    ),
    pollIntervalSec: Math.min(120, Math.max(5, Number($("pollInterval").value) || 20)),
  };
}

async function saveFormPrefs() {
  const f = readForm();
  await chrome.storage.local.set({
    [STORAGE_KEYS.mrArg]: f.mrArg,
    [STORAGE_KEYS.productionBranch]: f.productionBranch,
    [STORAGE_KEYS.dryRun]: f.dryRun,
    [STORAGE_KEYS.waitFeaturePipeline]: f.waitFeaturePipeline,
    [STORAGE_KEYS.stopAfterFeature]: f.stopAfterFeature,
    [STORAGE_KEYS.stopAfterPromoteMr]: f.stopAfterPromoteMr,
    [STORAGE_KEYS.skipBuildImage]: f.skipBuildImage,
    [STORAGE_KEYS.buildStage]: f.buildStage,
    [STORAGE_KEYS.pipelineTimeout]: f.pipelineTimeoutSec,
    [STORAGE_KEYS.pollInterval]: f.pollIntervalSec,
  });
}

async function loadFormPrefs() {
  const s = await chrome.storage.local.get({
    gitlabBaseUrl: "https://git-02.t1-group.ru",
    privateToken: "",
    pollIntervalSec: 25,
    [STORAGE_KEYS.mrArg]: "",
    [STORAGE_KEYS.productionBranch]: "",
    [STORAGE_KEYS.dryRun]: false,
    [STORAGE_KEYS.waitFeaturePipeline]: false,
    [STORAGE_KEYS.stopAfterFeature]: false,
    [STORAGE_KEYS.stopAfterPromoteMr]: false,
    [STORAGE_KEYS.skipBuildImage]: false,
    [STORAGE_KEYS.buildStage]: "build",
    [STORAGE_KEYS.pipelineTimeout]: 7200,
    [STORAGE_KEYS.pollInterval]: 20,
  });

  $("mrArg").value = s[STORAGE_KEYS.mrArg];
  $("productionBranch").value = s[STORAGE_KEYS.productionBranch];
  $("dryRun").checked = s[STORAGE_KEYS.dryRun];
  $("waitFeaturePipeline").checked = s[STORAGE_KEYS.waitFeaturePipeline];
  $("stopAfterFeature").checked = s[STORAGE_KEYS.stopAfterFeature];
  $("stopAfterPromoteMr").checked = s[STORAGE_KEYS.stopAfterPromoteMr];
  $("skipBuildImage").checked = s[STORAGE_KEYS.skipBuildImage];
  $("buildStage").value = s[STORAGE_KEYS.buildStage];
  $("pipelineTimeout").value = String(s[STORAGE_KEYS.pipelineTimeout]);
  $("pollInterval").value = String(s[STORAGE_KEYS.pollInterval]);

  if (!s.privateToken) {
    setStatus("Задайте токен в настройках (scope api для merge).", "warn");
  } else {
    setStatus(`GitLab: ${s.gitlabBaseUrl}`, undefined);
  }

  return s;
}

function showBootError(message) {
  const line = document.getElementById("statusLine");
  if (line) {
    line.textContent = "Ошибка: " + message;
    line.className = "err";
  }
}

function bindGlobalErrors() {
  window.addEventListener("error", (e) => {
    showBootError(e.message || "не удалось загрузить скрипт");
  });
  window.addEventListener("unhandledrejection", (e) => {
    const line = document.getElementById("statusLine");
    if (line && !line.textContent) {
      showBootError(e.reason?.message || String(e.reason));
    }
  });
}

function init() {
  bindGlobalErrors();
  bindUi();
  loadFormPrefs().catch((e) => setStatus(String(e), "err"));
}

function bindUi() {
$("openOptions").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

$("clearLog").addEventListener("click", () => {
  $("log").textContent = "";
  $("buildImageBlock").classList.remove("visible");
  $("buildImage").value = "";
  setStatus("", undefined);
});

$("copyImage").addEventListener("click", async () => {
  const v = $("buildImage").value;
  if (!v) return;
  try {
    await navigator.clipboard.writeText(v);
    setStatus("Образ скопирован.", "ok");
  } catch {
    $("buildImage").select();
    document.execCommand("copy");
    setStatus("Образ скопирован.", "ok");
  }
});

$("cancel").addEventListener("click", () => {
  abortController?.abort();
  setStatus("Отмена…", "warn");
});

$("run").addEventListener("click", async () => {
  const form = readForm();
  if (!form.mrArg) {
    setStatus("Укажите merge request.", "err");
    return;
  }

  setStatus("Запуск…", undefined);

  await saveFormPrefs();

  const settings = await chrome.storage.local.get({
    gitlabBaseUrl: "https://git-02.t1-group.ru",
    privateToken: "",
  });

  if (!settings.privateToken) {
    appendLog("Нет токена — откройте настройки расширения.");
    setStatus("Нет токена — откройте настройки расширения.", "err");
    return;
  }

  try {
    const okPerm = await ensureHostPermission(settings.gitlabBaseUrl);
    if (!okPerm) {
      setStatus("Нужен доступ к хосту GitLab в запросе разрешений браузера.", "err");
      return;
    }
  } catch (e) {
    setStatus(String(e), "err");
    return;
  }

  $("log").textContent = "";
  appendLog("Старт…");
  $("buildImageBlock").classList.remove("visible");
  $("buildImage").value = "";
  setRunning(true);
  setStatus("Выполняется…", undefined);

  abortController = new AbortController();
  const signal = abortController.signal;

  try {
    await runPromote(settings.gitlabBaseUrl, settings.privateToken, form, {
      signal,
      log: appendLog,
      onBuildImage: (image) => {
        $("buildImage").value = image;
        $("buildImageBlock").classList.add("visible");
      },
    });
    setStatus("Завершено успешно.", "ok");
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      appendLog("--- отменено пользователем ---");
      setStatus("Отменено.", "warn");
    } else {
      appendLog(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
      setStatus(e instanceof Error ? e.message : String(e), "err");
    }
  } finally {
    abortController = null;
    setRunning(false);
  }
});
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
