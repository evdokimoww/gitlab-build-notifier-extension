const defaults = {
  gitlabBaseUrl: "https://git-02.t1-group.ru",
  privateToken: "",
  stageName: "build",
  pollIntervalSec: 25,
  treatSkippedAsSuccess: true,
  treatCanceledAsFailure: true,
  enableFaviconTint: true,
  enableNotificationSound: true,
  projectWhitelist: "",
};

function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id}`);
  return el;
}

async function load() {
  const s = await chrome.storage.local.get(defaults);
  $("gitlabBaseUrl").value = s.gitlabBaseUrl;
  $("privateToken").value = s.privateToken;
  $("stageName").value = s.stageName;
  $("pollIntervalSec").value = String(s.pollIntervalSec);
  $("treatSkippedAsSuccess").checked = s.treatSkippedAsSuccess;
  $("treatCanceledAsFailure").checked = s.treatCanceledAsFailure;
  $("enableFaviconTint").checked = s.enableFaviconTint;
  $("enableNotificationSound").checked = s.enableNotificationSound;
  $("projectWhitelist").value = s.projectWhitelist;
}

function setStatus(text, ok) {
  const p = $("status");
  p.textContent = text;
  p.className = ok === true ? "ok" : ok === false ? "err" : "";
}

async function ensureHostPermission(gitlabBaseUrl) {
  const u = new URL(gitlabBaseUrl);
  const originPat = `${u.origin}/*`;
  const has = await chrome.permissions.contains({ origins: [originPat] });
  if (has) return true;
  return chrome.permissions.request({ origins: [originPat] });
}

$("save").addEventListener("click", async () => {
  setStatus("Сохранение…", undefined);
  const gitlabBaseUrl = $("gitlabBaseUrl").value.trim() || defaults.gitlabBaseUrl;
  try {
    new URL(gitlabBaseUrl);
  } catch {
    setStatus("Некорректный URL", false);
    return;
  }

  try {
    const okPerm = await ensureHostPermission(gitlabBaseUrl);
    if (!okPerm) {
      setStatus("Нужен доступ к хосту GitLab в запросе разрешений браузера", false);
      return;
    }
  } catch (e) {
    setStatus(String(e), false);
    return;
  }

  const pollIntervalSec = Math.min(600, Math.max(10, Number($("pollIntervalSec").value) || 25));

  await chrome.storage.local.set({
    gitlabBaseUrl,
    privateToken: $("privateToken").value,
    stageName: ($("stageName").value || "build").trim(),
    pollIntervalSec,
    treatSkippedAsSuccess: $("treatSkippedAsSuccess").checked,
    treatCanceledAsFailure: $("treatCanceledAsFailure").checked,
    enableFaviconTint: $("enableFaviconTint").checked,
    enableNotificationSound: $("enableNotificationSound").checked,
    projectWhitelist: $("projectWhitelist").value.trim(),
  });

  setStatus("Сохранено.", true);
});

$("resetNotified").addEventListener("click", async () => {
  await chrome.storage.local.set({ notified: {} });
  setStatus("Кэш уведомлений сброшен — следующий завершённый build снова вызовет оповещение.", true);
});

load().catch((e) => setStatus(String(e), false));
