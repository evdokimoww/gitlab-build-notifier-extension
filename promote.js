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
 * @param {string | null} highlightedId
 */
function renderSessionTabs(sessions, highlightedId) {
  const bar = $("sessionBar");
  bar.replaceChildren();

  if (!sessions.length) {
    bar.hidden = true;
    return;
  }

  bar.hidden = false;

  for (const session of sessions) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = `session-tab session-tab--${session.status}`;
    if (session.id === highlightedId) tab.classList.add("session-tab--active");
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

/**
 * @param {import("./promote-runner.js").PromoteSession | null | undefined} session
 * @param {import("./promote-runner.js").PromoteSession[]} sessions
 */
function viewSession(session, sessions) {
  if (!session) {
    activeSessionId = null;
    renderSessionTabs(sessions, null);
    clearDetailView();
    return;
  }
  activeSessionId = session.id;
  renderSessionTabs(sessions, session.id);
  applySession(session);
}

async function applyInitialSessionView(sessions, activeId) {
  const list = sessions || [];
  if (!list.length) {
    viewSession(null, []);
    return;
  }

  let picked = list.find((s) => s.id === activeId);
  if (!picked) {
    picked = list.find((s) => s.status === "running") || list[0];
    try {
      await chrome.runtime.sendMessage({
        type: "promote-set-active",
        sessionId: picked.id,
      });
    } catch {
      /* ignore */
    }
  }
  viewSession(picked, list);
}

async function syncSessionsFromBackground() {
  const res = await fetchSessions();
  await applyInitialSessionView(res.sessions || [], res.activeId);
  return res;
}

async function selectSession(sessionId) {
  const setRes = await chrome.runtime.sendMessage({
    type: "promote-set-active",
    sessionId,
  });
  if (!setRes?.ok) throw new Error(setRes?.error || "Не удалось переключить сессию");

  const res = await fetchSessions();
  const session = (res.sessions || []).find((s) => s.id === sessionId);
  if (!session) throw new Error("Сессия не найдена");
  viewSession(session, res.sessions || []);
}

async function dismissSession(sessionId) {
  const res = await chrome.runtime.sendMessage({
    type: "promote-dismiss",
    sessionId,
  });
  if (!res?.ok) throw new Error(res?.error || "Не удалось закрыть сессию");

  const list = await fetchSessions();
  const viewed = activeSessionId
    ? (list.sessions || []).find((s) => s.id === activeSessionId)
    : null;
  if (viewed) viewSession(viewed, list.sessions || []);
  else await applyInitialSessionView(list.sessions || [], list.activeId);

  await restoreReadyStatus();
}

async function restoreReadyStatus() {
  if (activeSessionId) return;

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
      viewSession(viewed || null, sessions);
      return;
    }

    if (sessions.length) {
      void applyInitialSessionView(sessions, state.activeId);
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

  $("planCancel").addEventListener("click", () => {
    closePlanDialog();
    setStatus("Запуск отменён — цепочка не подтверждена.", "warn");
  });

  $("planConfirm").addEventListener("click", () => {
    const form = pendingPlanForm;
    closePlanDialog();
    if (!form) return;
    void startPromoteAfterConfirm(form);
  });

  $("planDialog").addEventListener("cancel", (e) => {
    e.preventDefault();
    closePlanDialog();
    setStatus("Запуск отменён — цепочка не подтверждена.", "warn");
  });

  $("run").addEventListener("click", async () => {
    const form = readForm();
    if (!form.mrArg && !form.mrBatch) {
      setStatus("Укажите merge request (поле выше или список ниже).", "err");
      return;
    }

    setStatus("Анализ цепочки merge…", undefined);
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

    $("run").disabled = true;
    try {
      const res = await chrome.runtime.sendMessage({ type: "promote-plan", form });
      if (!res?.ok) {
        setStatus(res?.error || "Не удалось проанализировать цепочку", "err");
        return;
      }
      showPlanDialog(res.plan, form);
      setStatus("Проверьте цепочку и подтвердите запуск.", "warn");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "err");
    } finally {
      $("run").disabled = false;
    }
  });
}

/** @type {ReturnType<typeof readForm> | null} */
let pendingPlanForm = null;

/**
 * @param {import("./gitlab-promote.js").PromotePlanStep} step
 */
function stepKindLabel(step) {
  switch (step.kind) {
    case "feature":
      return "feature → develop";
    case "promote-create":
      return "promote MR";
    case "promote":
      return "develop → production";
    case "build":
      return "build";
    default:
      return step.kind;
  }
}

/**
 * @param {import("./gitlab-promote.js").PromotePlan} plan
 * @param {ReturnType<typeof readForm>} form
 */
function showPlanDialog(plan, form) {
  pendingPlanForm = form;
  const meta = $("planMeta");
  const prod = plan.productionBranch
    ? ` · production: <code>${escapeHtml(plan.productionBranch)}</code>`
    : "";
  meta.innerHTML =
    `Проект: <code>${escapeHtml(plan.project)}</code>` +
    ` · develop: <code>${escapeHtml(plan.developBranch)}</code>${prod}`;

  const flags = $("planFlags");
  flags.replaceChildren();
  /** @type {Array<[string, boolean]>} */
  const flagList = [
    ["dry run", plan.dryRun],
    ["только feature → develop", plan.stopAfterFeature],
    ["стоп после создания promote MR", plan.stopAfterPromoteMr],
    ["без build-образа", plan.skipBuildImage],
    ["ждать pipeline feature", plan.waitFeaturePipeline],
  ];
  let anyFlag = false;
  for (const [label, on] of flagList) {
    if (!on) continue;
    anyFlag = true;
    const span = document.createElement("span");
    span.className = "plan-flag" + (label === "dry run" ? " plan-flag--warn" : "");
    span.textContent = label;
    flags.append(span);
  }
  flags.hidden = !anyFlag;

  const list = $("planSteps");
  list.replaceChildren();
  for (const step of plan.steps) {
    const li = document.createElement("li");

    const kind = document.createElement("div");
    kind.className = "step-kind";
    kind.textContent = stepKindLabel(step);

    const title = document.createElement("div");
    title.className = "step-title";
    title.textContent = step.label;

    li.append(kind, title);

    if (step.mrTitle) {
      const mrTitle = document.createElement("div");
      mrTitle.className = "step-mr-title";
      mrTitle.textContent = step.mrTitle;
      li.append(mrTitle);
    }

    if (step.sourceBranch || step.targetBranch) {
      const flow = document.createElement("div");
      flow.className = "step-flow";
      if (step.kind === "build") {
        flow.textContent = step.targetBranch || "";
      } else {
        const src = document.createElement("span");
        src.textContent = step.sourceBranch || "?";
        const arrow = document.createElement("span");
        arrow.className = "arrow";
        arrow.textContent = "→";
        const dst = document.createElement("span");
        dst.textContent = step.targetBranch || "?";
        flow.append(src, arrow, dst);
      }
      li.append(flow);
    }

    if (step.note) {
      const note = document.createElement("div");
      note.className = "step-note";
      note.textContent = step.note;
      li.append(note);
    }

    list.append(li);
  }

  /** @type {HTMLDialogElement} */ ($("planDialog")).showModal();
}

function closePlanDialog() {
  pendingPlanForm = null;
  const dialog = /** @type {HTMLDialogElement} */ ($("planDialog"));
  if (dialog.open) dialog.close();
}

/** @param {string} s */
function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * @param {ReturnType<typeof readForm>} form
 */
async function startPromoteAfterConfirm(form) {
  setStatus("Запуск…", undefined);
  $("run").disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: "promote-start", form });
    if (!res?.ok) {
      setStatus(res?.error || "Не удалось запустить", "err");
      return;
    }

    $("mrArg").value = "";
    $("mrBatch").value = "";
    await chrome.storage.local.set({ [STORAGE_KEYS.mrArg]: "", [STORAGE_KEYS.mrBatch]: "" });

    if (res.sessionId) {
      await selectSession(res.sessionId);
    } else {
      await syncSessionsFromBackground();
    }
    $("mrArg").focus();
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), "err");
  } finally {
    $("run").disabled = false;
  }
}

function init() {
  bindStorageSync();
  bindUi();
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "PROMOTE_UI_FEEDBACK") return;
    void applyPromotePageFeedback(Boolean(msg.ok));
  });
  loadFormPrefs().catch((e) => setStatus(String(e), "err"));
}

/**
 * Мигание favicon / префикс title на странице promote (как на вкладках GitLab).
 * @param {boolean} ok
 */
async function applyPromotePageFeedback(ok) {
  const prefix = ok ? "[CI OK]" : "[CI FAIL]";
  const t = document.title.replace(/^\[(CI OK|CI FAIL|CI …)\]\s*/, "");
  document.title = `${prefix} ${t}`;

  const faviconPath = ok ? "icons/notify-ok.png" : "icons/notify-fail.png";
  const strongUrl = chrome.runtime.getURL(faviconPath);
  const size = 32;
  const fid = "__gitlab_ci_notifier_favicon__";
  const timerKey = "__gitlab_promote_favicon_iv__";

  function fadedIconDataUrl(src, opacity) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const c = canvas.getContext("2d");
        if (!c) {
          reject(new Error("canvas unavailable"));
          return;
        }
        c.clearRect(0, 0, size, size);
        c.globalAlpha = opacity;
        c.drawImage(img, 0, 0, size, size);
        resolve(canvas.toDataURL("image/png"));
      };
      img.onerror = reject;
      img.src = src;
    });
  }

  try {
    const softUrl = await fadedIconDataUrl(strongUrl, 0.28).catch(() => strongUrl);
    let link = document.getElementById(fid);
    if (!link) {
      link = document.createElement("link");
      link.id = fid;
      link.rel = "icon";
      link.type = "image/png";
      document.head.appendChild(link);
    }
    const prevIv = window[timerKey];
    if (typeof prevIv === "number") window.clearInterval(prevIv);

    let blinkOn = true;
    let ticks = 0;
    function showFrame() {
      link.href = blinkOn ? strongUrl : softUrl;
      blinkOn = !blinkOn;
      ticks += 1;
      if (ticks >= 28) {
        window.clearInterval(window[timerKey]);
        window[timerKey] = 0;
        link.href = strongUrl;
      }
    }
    showFrame();
    window[timerKey] = window.setInterval(showFrame, 450);
  } catch (e) {
    console.warn("[promote] favicon feedback:", e);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
