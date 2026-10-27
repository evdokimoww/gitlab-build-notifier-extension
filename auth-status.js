import { JIRA_DEFAULTS, checkGitlabAuth, checkJiraAuth, normalizeBaseUrl } from "./jira-api.js";

const defaults = {
  gitlabBaseUrl: "https://git-02.t1-group.ru", privateToken: "", ...JIRA_DEFAULTS,
};

/** Render live checks of saved credentials; no token or cookie values are added to the DOM. */
export async function renderAuthStatus(container, settings) {
  container.replaceChildren();
  settings ??= await chrome.storage.local.get(defaults);
  const services = [
    { label: "GitLab · токен", baseUrl: settings.gitlabBaseUrl,
      check: () => checkGitlabAuth(settings.gitlabBaseUrl, settings.privateToken) },
    ...settings.jiraBaseUrls.map(baseUrl => ({ label: "Jira · сессия браузера", baseUrl,
      check: () => checkJiraAuth(baseUrl), disabled: !settings.enableJiraLinks })),
  ];
  await Promise.all(services.map(async service => {
    const row = document.createElement("div");
    row.className = "auth-row";
    const heading = document.createElement("strong");
    heading.textContent = service.label;
    const address = document.createElement("span");
    address.className = "auth-address";
    const state = document.createElement("span");
    state.className = "auth-state";
    state.textContent = "Проверяем доступ…";
    row.append(heading, address, state);
    container.append(row);
    try {
      const baseUrl = normalizeBaseUrl(service.baseUrl);
      address.textContent = baseUrl;
      if (service.disabled) {
        state.textContent = "Проверка ссылок Jira выключена";
        return;
      }
      const result = await service.check();
      state.textContent = result.name ? `${result.message}: ${result.name}` : result.message;
      row.dataset.state = result.state;
      if (service.label.startsWith("Jira") && result.state !== "permission") {
        const login = document.createElement("a");
        login.href = baseUrl;
        login.target = "_blank";
        login.rel = "noopener noreferrer";
        login.textContent = result.state === "connected" ? "Открыть Jira" : "Открыть Jira / войти";
        row.append(login);
      }
    } catch {
      state.textContent = "Не удалось проверить доступ. Проверьте URL в настройках.";
    }
  }));
}

export function bindAuthStatus() {
  const container = document.getElementById("authStatus");
  const button = document.getElementById("checkAuth");
  const connect = document.getElementById("connectSites");
  const hint = document.getElementById("connectionHint");
  let origins = [];
  let refreshSequence = 0;
  const refresh = async () => {
    const sequence = ++refreshSequence;
    const isCurrent = () => sequence === refreshSequence;
    button.disabled = true;
    connect.disabled = true;
    try {
      const settings = await chrome.storage.local.get(defaults);
      const urls = settings.enableJiraLinks
        ? [settings.gitlabBaseUrl, ...settings.jiraBaseUrls] : [settings.gitlabBaseUrl];
      const nextOrigins = [...new Set(urls.map(url => `${new URL(normalizeBaseUrl(url)).origin}/*`))];
      const allowed = await chrome.permissions.contains({ origins: nextOrigins });
      if (!isCurrent()) return false;
      origins = nextOrigins;
      connect.hidden = allowed;
      connect.disabled = false;
      hint.hidden = allowed;
      hint.textContent = "Разрешите расширению доступ к сайтам. Токен GitLab для проверки Jira не нужен.";
      await renderAuthStatus(container, settings);
      return isCurrent();
    }
    catch {
      if (isCurrent()) container.textContent = "Не удалось прочитать настройки.";
      return false;
    }
    finally { if (isCurrent()) button.disabled = false; }
  };
  connect.addEventListener("click", async () => {
    if (!origins.length) return;
    connect.disabled = true;
    try {
      // Request synchronously from the click, using origins loaded before the user gesture.
      const allowed = await chrome.permissions.request({ origins });
      if (!await refresh()) return;
      hint.hidden = false;
      hint.textContent = allowed && connect.hidden
        ? "Доступ выдан. Ссылки в открытых вкладках GitLab проверяются автоматически."
        : allowed ? "Для текущих настроек ещё нужен доступ. Нажмите «Подключить сайты»."
        : "Доступ не выдан. Нажмите «Подключить сайты» и подтвердите запрос браузера.";
    } catch {
      hint.hidden = false;
      hint.textContent = "Не удалось получить доступ. Откройте настройки расширения и сохраните их.";
    } finally { if (!button.disabled) connect.disabled = false; }
  });
  button.addEventListener("click", refresh);
  refresh();
  return refresh;
}
