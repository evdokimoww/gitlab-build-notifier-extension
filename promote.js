const STORAGE_KEYS = {
  mrArg: "promoteMrArg",
  mrBatch: "promoteMrBatch",
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

/** @type {string | null} */
let activeSessionId = null;

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

function setLogText(text) {
  const el = $("log");
  el.textContent = text;
  el.scrollTop = el.scrollHeight;
}

/** @param {{ mrArg?: string, mrBatch?: string, sessionLabel?: string }} form */
function buildSessionLabel(form) {
  if (form.sessionLabel) return form.sessionLabel;
  const parts = [];
  if (form.mrArg?.trim()) parts.push(sessionLabel(form.mrArg.trim()));
  if (form.mrBatch?.trim()) {
    for (const line of form.mrBatch.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      parts.push(sessionLabel(t));
    }
  }
  if (parts.length <= 1) return parts[0] || form.mrArg || "";
  return `${parts[0]} +${parts.length - 1}`;
}

/** @param {string} mrArg */
function sessionLabel(mrArg) {
  const ref = mrArg.match(/!(?<iid>\d+)$/);
  if (ref?.groups) return `!${ref.groups.iid}`;
  const url = mrArg.match(/merge_requests\/(\d+)/i);
  if (url) return `!${url[1]}`;
  const t = mrArg.trim();
  return t.length > 28 ? `${t.slice(0, 28)}…` : t || "MR";
}

/**
 * @param {{ id: string, status: string, mrArg: string }} session
 */
function statusTitle(session) {
  const map = {
    running: "выполняется",
    success: "готово",
    error: "ошибка",
    cancelled: "отменено",
    stale: "прервано",
  };
  return map[session.status] || session.status;
}

function setActiveSessionControls(session) {
  const running = session?.status === "running";
  $("cancel").disabled = !running;
  $("newMr").hidden = !(session?.status === "success" && session?.buildImage);
}

function clearDetailView() {
  setLogText("");
  $("buildImage").value = "";
  $("buildImageBlock").classList.remove("visible");
  $("newMr").hidden = true;
  setActiveSessionControls(null);
}

/**
 * @param {import("./promote-runner.js").PromoteSession | null | undefined} session
 */
function applySession(session) {
  if (!session) {
    clearDetailView();
    return;
  }

  activeSessionId = session.id;
  setLogText((session.logs || []).join("\n"));
  setActiveSessionControls(session);

  if (session.buildImage) {
    $("buildImage").value = session.buildImage;
    $("buildImageBlock").classList.add("visible");
  } else {
    $("buildImage").value = "";
    $("buildImageBlock").classList.remove("visible");
  }

  if (session.statusText) {
    setStatus(session.statusText, session.statusKind || undefined);
  } else if (session.status === "running") {
    setStatus("Выполняется… (можно запустить ещё MR параллельно)", undefined);
  }
}

/**
 * @param {import("./promote-runner.js").PromoteSession[]} sessions
 * @param {string | null} activeId
 */
function renderSessionTabs(sessions, activeId) {
  const bar = $("sessionBar");
  bar.replaceChildren();

  if (!sessions.length) {
    bar.hidden = true;
    return;
  }

  bar.hidden = false;
  activeSessionId = activeId;

  for (const session of sessions) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = `session-tab session-tab--${session.status}`;
    if (session.id === activeId) tab.classList.add("session-tab--active");
    tab.title = `${session.mrArg} — ${statusTitle(session)}`;
    tab.dataset.sessionId = session.id;

    const label = document.createElement("span");
    label.className = "session-tab-label";
    label.textContent = sessionLabel(session.mrArg);

    const badge = document.createElement("span");
    badge.className = "session-tab-badge";
    badge.textContent = statusTitle(session);

    tab.append(label, badge);

    if (session.status !== "running") {
      const close = document.createElement("span");
      close.className = "session-tab-close";
      close.textContent = "×";
      close.title = "Убрать из списка";
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        dismissSession(session.id).catch((err) => setStatus(String(err), "err"));
      });
      tab.appendChild(close);
    }

    tab.addEventListener("click", () => {
      selectSession(session.id).catch((err) => setStatus(String(err), "err"));
    });

    bar.appendChild(tab);
  }
}

async function fetchSessions() {
  const res = await chrome.runtime.sendMessage({ type: "promote-get-sessions" });
  if (!res?.ok) throw new Error(res?.error || "Не удалось загрузить сессии");
  return res;
}

function applyInitialSessionView(sessions, activeId) {
  const running = (sessions || []).filter((s) => s.status === "running");
  const active = running.find((s) => s.id === activeId) || running[0] || null;

  if (active) {
    activeSessionId = active.id;
    renderSessionTabs(sessions, active.id);
    applySession(active);
    return;
  }

  activeSessionId = null;
  renderSessionTabs(sessions, null);
  clearDetailView();
}

async function syncSessionsFromBackground() {
  const res = await fetchSessions();
  applyInitialSessionView(res.sessions || [], res.activeId);
  return res;
}

async function selectSession(sessionId) {
  const res = await chrome.runtime.sendMessage({
    type: "promote-set-active",
    sessionId,
  });
  if (!res?.ok) throw new Error(res?.error || "Не удалось переключить сессию");
  await syncSessionsFromBackground();
}

async function dismissSession(sessionId) {
  const res = await chrome.runtime.sendMessage({
    type: "promote-dismiss",
    sessionId,
  });
  if (!res?.ok) throw new Error(res?.error || "Не удалось закрыть сессию");
  await syncSessionsFromBackground();
  await restoreReadyStatus();
}

async function restoreReadyStatus() {
  const res = await fetchSessions().catch(() => null);
  const active = res?.sessions?.find((s) => s.id === res.activeId);
  if (active?.status === "running") return;

  const anyRunning = res?.sessions?.some((s) => s.status === "running");
  if (anyRunning) {
    setStatus("Есть другие активные сессии — выберите вкладку выше", undefined);
    return;
  }

  const s = await chrome.storage.local.get({
    gitlabBaseUrl: "https://git-02.t1-group.ru",
    privateToken: "",
  });
  if (!s.privateToken) {
    setStatus("Задайте токен в настройках (scope api для merge).", "warn");
  } else {
    setStatus(`GitLab: ${s.gitlabBaseUrl}`, undefined);
  }
}

async function resetForNewMr() {
  if (activeSessionId) {
    await chrome.runtime.sendMessage({
      type: "promote-dismiss",
      sessionId: activeSessionId,
    });
  }

  $("mrArg").value = "";
  $("mrBatch").value = "";
  clearDetailView();
  await chrome.storage.local.set({ [STORAGE_KEYS.mrArg]: "", [STORAGE_KEYS.mrBatch]: "" });
  await syncSessionsFromBackground();
  await restoreReadyStatus();
  $("mrArg").focus();
}

async function ensureHostPermission(gitlabBaseUrl) {
  const u = new URL(gitlabBaseUrl);
  const originPat = `${u.origin}/*`;
  const has = await chrome.permissions.contains({ origins: [originPat] });
  if (has) return true;
  return chrome.permissions.request({ origins: [originPat] });
}

function readForm() {
  const mrArg = $("mrArg").value.trim();
  const mrBatch = $("mrBatch").value.trim();
  const form = {
    mrArg,
    mrBatch,
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
  form.sessionLabel = buildSessionLabel(form);
  return form;
}

async function saveFormPrefs() {
  const f = readForm();
  await chrome.storage.local.set({
    [STORAGE_KEYS.mrArg]: f.mrArg,
    [STORAGE_KEYS.mrBatch]: f.mrBatch,
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
    [STORAGE_KEYS.mrArg]: "",
    [STORAGE_KEYS.mrBatch]: "",
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
  $("mrBatch").value = s[STORAGE_KEYS.mrBatch];
  $("productionBranch").value = s[STORAGE_KEYS.productionBranch];
  $("dryRun").checked = s[STORAGE_KEYS.dryRun];
  $("waitFeaturePipeline").checked = s[STORAGE_KEYS.waitFeaturePipeline];
  $("stopAfterFeature").checked = s[STORAGE_KEYS.stopAfterFeature];
  $("stopAfterPromoteMr").checked = s[STORAGE_KEYS.stopAfterPromoteMr];
  $("skipBuildImage").checked = s[STORAGE_KEYS.skipBuildImage];
  $("buildStage").value = s[STORAGE_KEYS.buildStage];
  $("pipelineTimeout").value = String(s[STORAGE_KEYS.pipelineTimeout]);
  $("pollInterval").value = String(s[STORAGE_KEYS.pollInterval]);

  await syncSessionsFromBackground();
  const res = await fetchSessions().catch(() => null);
  const hasRunning = res?.sessions?.some((s) => s.status === "running");
  if (!hasRunning) {
    $("mrArg").value = "";
    $("mrBatch").value = "";
    await chrome.storage.local.set({
      [STORAGE_KEYS.mrArg]: "",
      [STORAGE_KEYS.mrBatch]: "",
    });
  }
  await restoreReadyStatus();
}

function bindStorageSync() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.promoteSessions) return;
    const state = changes.promoteSessions.newValue;
    if (!state) return;
    const sessions = Object.values(state.items || {}).sort((a, b) => b.startedAt - a.startedAt);

    if (activeSessionId) {
      const viewed = sessions.find((s) => s.id === activeSessionId);
      renderSessionTabs(sessions, activeSessionId);
      applySession(viewed || null);
      if (!viewed) activeSessionId = null;
      return;
    }

    const running = sessions.filter((s) => s.status === "running");
    if (running.length) {
      applyInitialSessionView(sessions, state.activeId);
      return;
    }

    renderSessionTabs(sessions, null);
    clearDetailView();
  });
}

function bindUi() {
  $("openOptions").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  $("newMr").addEventListener("click", () => {
    resetForNewMr().catch((e) => setStatus(String(e), "err"));
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

  $("cancel").addEventListener("click", async () => {
    if (!activeSessionId) return;
    await chrome.runtime.sendMessage({
      type: "promote-cancel",
      sessionId: activeSessionId,
    });
    setStatus("Отмена…", "warn");
  });

  $("run").addEventListener("click", async () => {
    const form = readForm();
    if (!form.mrArg && !form.mrBatch) {
      setStatus("Укажите merge request (поле выше или список ниже).", "err");
      return;
    }

    setStatus("Запуск…", undefined);
    await saveFormPrefs();

    const settings = await chrome.storage.local.get({
      gitlabBaseUrl: "https://git-02.t1-group.ru",
      privateToken: "",
    });

    if (!settings.privateToken) {
      setLogText("Нет токена — откройте настройки расширения.");
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

    try {
      const res = await chrome.runtime.sendMessage({ type: "promote-start", form });
      if (!res?.ok) {
        setStatus(res?.error || "Не удалось запустить", "err");
        return;
      }

      $("mrArg").value = "";
      $("mrBatch").value = "";
      await chrome.storage.local.set({ [STORAGE_KEYS.mrArg]: "", [STORAGE_KEYS.mrBatch]: "" });

      await syncSessionsFromBackground();
      if (res.sessionId) await selectSession(res.sessionId);
      $("mrArg").focus();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "err");
    }
  });
}

function init() {
  bindStorageSync();
  bindUi();
  loadFormPrefs().catch((e) => setStatus(String(e), "err"));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
