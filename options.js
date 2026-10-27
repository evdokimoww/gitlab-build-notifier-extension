import {
  DEFAULT_BRANCH_MAPPINGS,
  parseBranchMappings,
} from "./gitlab-promote.js";
import { JIRA_DEFAULTS, normalizeBaseUrl, normalizeJiraUrls } from "./jira-api.js";
import { bindAuthStatus } from "./auth-status.js";

const defaults = {
  ...JIRA_DEFAULTS,
  gitlabBaseUrl: "https://git-02.t1-group.ru",
  privateToken: "",
  stageName: "build",
  pollIntervalSec: 25,
  treatSkippedAsSuccess: true,
  treatCanceledAsFailure: true,
  enableFaviconTint: true,
  enableNotificationSound: true,
  projectWhitelist: "",
  uiTheme: "system",
  promoteBranchMappings: DEFAULT_BRANCH_MAPPINGS,
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
  $("enableJiraLinks").checked = s.enableJiraLinks;
  $("jiraUrl1").value = s.jiraBaseUrls[0];
  $("jiraUrl2").value = s.jiraBaseUrls[1];
  $("stageName").value = s.stageName;
  $("pollIntervalSec").value = String(s.pollIntervalSec);
  $("treatSkippedAsSuccess").checked = s.treatSkippedAsSuccess;
  $("treatCanceledAsFailure").checked = s.treatCanceledAsFailure;
  $("enableFaviconTint").checked = s.enableFaviconTint;
  $("enableNotificationSound").checked = s.enableNotificationSound;
  $("projectWhitelist").value = s.projectWhitelist;
  $("promoteBranchMappings").value =
    s.promoteBranchMappings?.trim() ? s.promoteBranchMappings : DEFAULT_BRANCH_MAPPINGS;
  $("themeToggle").checked =
    s.uiTheme === "dark" ||
    (s.uiTheme === "system" &&
      globalThis.matchMedia("(prefers-color-scheme: dark)").matches);
}

function setStatus(text, ok) {
  const p = $("status");
  p.textContent = text;
  p.className = ok === true ? "ok" : ok === false ? "err" : "";
}

$("themeToggle").addEventListener("change", async () => {
  const theme = $("themeToggle").checked ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  await chrome.storage.local.set({ uiTheme: theme });
  setStatus(
    theme === "dark" ? "Тёмная тема включена." : "Светлая тема включена.",
    true,
  );
});

$("save").addEventListener("click", async () => {
  setStatus("Сохранение…", undefined);
  let gitlabBaseUrl;
  let jiraBaseUrls;
  const enableJiraLinks = $("enableJiraLinks").checked;
  try {
    gitlabBaseUrl = normalizeBaseUrl($("gitlabBaseUrl").value.trim() || defaults.gitlabBaseUrl);
    jiraBaseUrls = normalizeJiraUrls([$("jiraUrl1").value, $("jiraUrl2").value]);
  } catch (e) {
    setStatus(e.message || "Некорректный URL", false);
    return;
  }

  try {
    const hosts = enableJiraLinks ? [gitlabBaseUrl, ...jiraBaseUrls] : [gitlabBaseUrl];
    const origins = [...new Set(hosts.map(url => `${new URL(url).origin}/*`))];
    const okPerm = await chrome.permissions.request({ origins });
    if (!okPerm) {
      setStatus(
        "Для сохранения нужен доступ к GitLab и включённым Jira. Разрешите доступ в запросе браузера.",
        false,
      );
      return;
    }
  } catch (e) {
    setStatus(String(e), false);
    return;
  }

  const pollIntervalSec = Math.min(
    600,
    Math.max(10, Number($("pollIntervalSec").value) || 25),
  );

  let promoteBranchMappings = $("promoteBranchMappings").value;
  if (!promoteBranchMappings.trim()) {
    promoteBranchMappings = DEFAULT_BRANCH_MAPPINGS;
    $("promoteBranchMappings").value = DEFAULT_BRANCH_MAPPINGS;
  }
  try {
    parseBranchMappings(promoteBranchMappings);
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), false);
    return;
  }

  await chrome.storage.local.set({
    gitlabBaseUrl,
    privateToken: $("privateToken").value.trim(),
    enableJiraLinks,
    jiraBaseUrls,
    stageName: ($("stageName").value || "build").trim(),
    pollIntervalSec,
    treatSkippedAsSuccess: $("treatSkippedAsSuccess").checked,
    treatCanceledAsFailure: $("treatCanceledAsFailure").checked,
    enableFaviconTint: $("enableFaviconTint").checked,
    enableNotificationSound: $("enableNotificationSound").checked,
    projectWhitelist: $("projectWhitelist").value.trim(),
    promoteBranchMappings,
  });

  setStatus("Сохранено.", true);
  refreshAuth();
});

$("resetNotified").addEventListener("click", async () => {
  await chrome.storage.local.set({ notified: {} });
  setStatus(
    "Кэш уведомлений сброшен — следующий завершённый build снова вызовет оповещение.",
    true,
  );
});

const refreshAuth = bindAuthStatus();
load().catch((e) => setStatus(String(e), false));
