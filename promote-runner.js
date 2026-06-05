/**
 * Фоновый запуск promote: несколько параллельных сессий в chrome.storage.local.
 */

import { MrMergeConflictError, runPromote } from "./gitlab-promote.js";

export const PROMOTE_SESSIONS_KEY = "promoteSessions";
/** @deprecated миграция со старого формата */
export const PROMOTE_SESSION_KEY = "promoteSession";

/** @type {Map<string, AbortController>} */
const runningAborts = new Map();

const STALE_RUNNING_SEC = 10 * 60;
export const PROMOTE_KEEPALIVE_ALARM = "promote-keepalive";

/**
 * @typedef {'idle'|'running'|'success'|'error'|'cancelled'|'stale'} PromoteStatus
 * @typedef {{
 *   id: string,
 *   status: PromoteStatus,
 *   logs: string[],
 *   buildImage: string,
 *   mrArg: string,
 *   error: string,
 *   statusText: string,
 *   statusKind: string,
 *   updatedAt: number,
 *   startedAt: number,
 * }} PromoteSession
 * @typedef {{ activeId: string | null, items: Record<string, PromoteSession> }} PromoteSessionsState
 */

/** @returns {PromoteSession} */
export function emptyPromoteSession(id = "") {
  return {
    id,
    status: "idle",
    logs: [],
    buildImage: "",
    mrArg: "",
    error: "",
    statusText: "",
    statusKind: "",
    updatedAt: 0,
    startedAt: 0,
  };
}

function createSessionId() {
  return `ps-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** @returns {PromoteSessionsState} */
function emptySessionsState() {
  return { activeId: null, items: {} };
}

async function migrateLegacySession(state) {
  const legacy = await chrome.storage.local.get(PROMOTE_SESSION_KEY);
  const old = legacy[PROMOTE_SESSION_KEY];
  if (!old || old.status === "idle" || Object.keys(state.items).length > 0) return state;

  const id = createSessionId();
  state.items[id] = { ...emptyPromoteSession(id), ...old, id };
  state.activeId = id;
  await chrome.storage.local.remove(PROMOTE_SESSION_KEY);
  return state;
}

/** @returns {Promise<PromoteSessionsState>} */
export async function loadSessionsState() {
  const data = await chrome.storage.local.get({
    [PROMOTE_SESSIONS_KEY]: emptySessionsState(),
  });
  let state = data[PROMOTE_SESSIONS_KEY] || emptySessionsState();
  if (!state.items) state = emptySessionsState();
  state = await migrateLegacySession(state);
  return state;
}

async function saveSessionsState(state) {
  await chrome.storage.local.set({ [PROMOTE_SESSIONS_KEY]: state });
}

/** Снять выделение с завершённой сессии — при обновлении страницы форма остаётся пустой. */
async function releaseActiveSession(sessionId) {
  const state = await loadSessionsState();
  if (state.activeId !== sessionId) return;
  state.activeId = null;
  await saveSessionsState(state);
}

/** @returns {Promise<PromoteSession[]>} */
export async function listPromoteSessions() {
  const state = await loadSessionsState();
  return Object.values(state.items).sort((a, b) => b.startedAt - a.startedAt);
}

/** @returns {Promise<{ state: PromoteSessionsState, session: PromoteSession | null }>} */
export async function getActivePromoteSession() {
  const state = await loadSessionsState();
  if (!state.activeId) return { state, session: null };
  const session = state.items[state.activeId] || null;
  return { state, session };
}

/**
 * @param {string} id
 * @param {Partial<PromoteSession>} patch
 */
async function patchSessionById(id, patch) {
  const state = await loadSessionsState();
  const current = state.items[id] || emptyPromoteSession(id);
  state.items[id] = {
    ...current,
    ...patch,
    id,
    updatedAt: Date.now(),
  };
  await saveSessionsState(state);
  return state.items[id];
}

/** @param {string} id @param {string} line */
async function appendSessionLog(id, line) {
  const state = await loadSessionsState();
  const current = state.items[id] || emptyPromoteSession(id);
  state.items[id] = {
    ...current,
    logs: [...(current.logs || []), line],
    updatedAt: Date.now(),
  };
  await saveSessionsState(state);
}

export async function setActivePromoteSession(id) {
  const state = await loadSessionsState();
  if (!state.items[id]) throw new Error("Сессия не найдена");
  state.activeId = id;
  await saveSessionsState(state);
  return state.items[id];
}

export async function dismissPromoteSession(id) {
  const state = await loadSessionsState();
  runningAborts.get(id)?.abort();
  runningAborts.delete(id);
  delete state.items[id];
  if (state.activeId === id) {
    const remaining = Object.values(state.items).sort((a, b) => b.startedAt - a.startedAt);
    state.activeId = remaining[0]?.id || null;
  }
  await saveSessionsState(state);
  syncKeepaliveAlarm();
  return state.activeId;
}

/** @deprecated */
export async function getPromoteSession() {
  const { session } = await getActivePromoteSession();
  return session || emptyPromoteSession();
}

export async function reconcileStalePromoteSession() {
  await reconcileStaleSessions();
  return getPromoteSession();
}

export async function reconcileStaleSessions() {
  const state = await loadSessionsState();
  let changed = false;

  for (const [id, session] of Object.entries(state.items)) {
    if (session.status !== "running") continue;
    if (runningAborts.has(id)) continue;

    const ageSec = (Date.now() - session.updatedAt) / 1000;
    if (ageSec < STALE_RUNNING_SEC) continue;

    state.items[id] = {
      ...session,
      status: "stale",
      logs: [
        ...session.logs,
        "--- процесс прерван (service worker перезапущен). Проверьте GitLab или запустите снова ---",
      ],
      statusText: "Процесс прерван. Запустите снова или проверьте GitLab.",
      statusKind: "warn",
      updatedAt: Date.now(),
    };
    changed = true;
  }

  if (changed) await saveSessionsState(state);
  return state;
}

export function isPromoteRunning() {
  return runningAborts.size > 0;
}

function syncKeepaliveAlarm() {
  if (runningAborts.size > 0) startPromoteKeepalive();
  else stopPromoteKeepalive();
}

export async function resetPromoteSession() {
  const state = await loadSessionsState();
  if (state.activeId) await dismissPromoteSession(state.activeId);
}

export function cancelPromoteRun(sessionId) {
  if (!sessionId) {
    for (const ctrl of runningAborts.values()) ctrl.abort();
    return;
  }
  runningAborts.get(sessionId)?.abort();
}

export function startPromoteKeepalive() {
  chrome.alarms.create(PROMOTE_KEEPALIVE_ALARM, { delayInMinutes: 0.5 });
}

export function stopPromoteKeepalive() {
  chrome.alarms.clear(PROMOTE_KEEPALIVE_ALARM);
}

export async function promoteKeepaliveTick() {
  await reconcileStaleSessions();
  if (runningAborts.size > 0) startPromoteKeepalive();
  else {
    const state = await loadSessionsState();
    const anyRunning = Object.values(state.items).some((s) => s.status === "running");
    if (anyRunning) startPromoteKeepalive();
    else stopPromoteKeepalive();
  }
}

/**
 * @param {import("./gitlab-promote.js").PromoteOptions} form
 * @param {{ gitlabBaseUrl: string, privateToken: string }} settings
 */
export async function acceptPromoteStart(form, settings) {
  await reconcileStaleSessions();

  const sessionId = createSessionId();
  const state = await loadSessionsState();

  state.items[sessionId] = {
    ...emptyPromoteSession(sessionId),
    status: "running",
    logs: ["Старт…"],
    mrArg: form.sessionLabel || form.mrArg,
    statusText: "Выполняется…",
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  state.activeId = sessionId;
  await saveSessionsState(state);

  const abort = new AbortController();
  runningAborts.set(sessionId, abort);
  syncKeepaliveAlarm();

  void executePromoteRun(sessionId, form, settings, abort.signal);

  return { ok: true, sessionId };
}

/**
 * @param {string} sessionId
 * @param {import("./gitlab-promote.js").PromoteOptions} form
 * @param {{ gitlabBaseUrl: string, privateToken: string }} settings
 * @param {AbortSignal} signal
 */
async function notifyPromoteConflict(sessionId, mr, message) {
  const iid = mr?.iid ?? "?";
  const notifId = `promote-conflict-${sessionId}-${iid}`;
  try {
    await chrome.notifications.clear(notifId).catch(() => {});
    await chrome.notifications.create(notifId, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/notify-fail.png"),
      title: `GitLab: конфликт MR !${iid}`,
      message: String(message).slice(0, 240),
      priority: 2,
    });
  } catch (e) {
    console.warn("[gitlab-notifier] promote conflict notification:", e);
  }
}

async function executePromoteRun(sessionId, form, settings, signal) {
  try {
    const result = await runPromote(settings.gitlabBaseUrl, settings.privateToken, form, {
      signal,
      log: (line) => appendSessionLog(sessionId, line),
      heartbeat: () => patchSessionById(sessionId, {}),
      onBuildImage: (image) => patchSessionById(sessionId, { buildImage: image }),
      onConflict: (mr, message) => notifyPromoteConflict(sessionId, mr, message),
    });
    if (result.buildImage) {
      await patchSessionById(sessionId, { buildImage: result.buildImage });
    }
    await patchSessionById(sessionId, {
      status: "success",
      statusText: "Завершено успешно.",
      statusKind: "ok",
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      await appendSessionLog(sessionId, "--- отменено пользователем ---");
      await patchSessionById(sessionId, {
        status: "cancelled",
        statusText: "Отменено.",
        statusKind: "warn",
      });
    } else if (e instanceof MrMergeConflictError) {
      await appendSessionLog(sessionId, `Конфликт: ${e.message}`);
      await patchSessionById(sessionId, {
        status: "error",
        error: e.message,
        statusText: "Конфликт при merge — см. уведомление",
        statusKind: "err",
      });
    } else {
      const message = e instanceof Error ? e.message : String(e);
      await appendSessionLog(sessionId, `Ошибка: ${message}`);
      await patchSessionById(sessionId, {
        status: "error",
        error: message,
        statusText: message,
        statusKind: "err",
      });
    }
  } finally {
    runningAborts.delete(sessionId);
    syncKeepaliveAlarm();
    await releaseActiveSession(sessionId);
  }
}
