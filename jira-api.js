export const JIRA_DEFAULTS = {
  enableJiraLinks: true,
  jiraBaseUrls: ["https://tasks.t1-group.ru", "https://jira.t1-group.ru"],
};

export function normalizeBaseUrl(value) {
  const url = new URL(value.trim());
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Укажите базовый HTTP(S) URL без логина, параметров и фрагмента.");
  }
  return url.href.replace(/\/+$/, "");
}

export function normalizeJiraUrls(values) {
  const urls = [...new Set(values.map(normalizeBaseUrl))];
  if (urls.length !== 2) throw new Error("Укажите два разных базовых URL Jira.");
  return urls;
}

const messages = {
  connected: "Авторизован",
  permission: "Нужен доступ к сайту. Нажмите «Подключить сайты» в расширении.",
  "no-token": "Токен GitLab не задан",
  "invalid-token": "Токен GitLab недействителен или истёк",
  login: "Сессия Jira недоступна. Откройте Jira и войдите.",
  forbidden: "Сервер запретил доступ",
  "not-found": "Задача не найдена или нет прав на её просмотр",
  unavailable: "Сервер недоступен. Проверьте сеть или VPN.",
  "invalid-response": "Сервер вернул неожиданный ответ",
  found: "Задача найдена",
};

function status(state, extra = {}) {
  return { state, message: messages[state], ...extra };
}

/** Request only the configured service, letting the browser attach its existing Jira session. */
async function readJson(url, { token, jira = false } = {}) {
  if (!await chrome.permissions.contains({ origins: [`${new URL(url).origin}/*`] })) {
    return status("permission");
  }
  try {
    const headers = { Accept: "application/json" };
    if (token) headers["PRIVATE-TOKEN"] = token;
    const response = await fetch(url, {
      headers,
      credentials: jira ? "include" : "omit",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (response.type === "opaqueredirect" || response.status === 401 ||
        (response.status >= 300 && response.status < 400)) {
      return status(jira ? "login" : "invalid-token");
    }
    if (response.status === 403) return status("forbidden");
    if (response.status === 404) return status("not-found");
    if (!response.ok) return status("unavailable");
    if (!response.headers.get("content-type")?.includes("application/json")) {
      return status(jira ? "login" : "invalid-response");
    }
    try {
      return { state: "ok", data: await response.json() };
    } catch {
      return status("invalid-response");
    }
  } catch {
    return status("unavailable");
  }
}

export async function checkGitlabAuth(baseUrl, token) {
  if (!token?.trim()) return status("no-token");
  const result = await readJson(`${normalizeBaseUrl(baseUrl)}/api/v4/user`, { token: token.trim() });
  if (result.state !== "ok") return result;
  if (!result.data?.id || !result.data.username) return status("invalid-response");
  return status("connected", { name: result.data.username });
}

export async function checkJiraAuth(baseUrl) {
  const result = await readJson(`${normalizeBaseUrl(baseUrl)}/rest/api/2/myself`, { jira: true });
  if (result.state !== "ok") return result;
  const name = result.data?.displayName || result.data?.name || result.data?.accountId;
  return name ? status("connected", { name }) : status("login");
}

export async function checkJiraIssue(baseUrl, key) {
  const result = await readJson(
    `${baseUrl}/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary`,
    { jira: true },
  );
  if (result.state !== "ok") return { baseUrl, ...result };
  if (!result.data?.id || result.data.key?.toUpperCase() !== key) {
    return { baseUrl, ...status("invalid-response") };
  }
  return { baseUrl, ...status("found"), url: `${baseUrl}/browse/${encodeURIComponent(key)}` };
}

/** Share concurrent checks and briefly cache results, without caching an auth failure as absence. */
export function createJiraResolver() {
  const cache = new Map();
  return {
    clear() { cache.clear(); },
    async resolve(key, baseUrls, refresh = false) {
      if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) throw new Error("Некорректный ключ задачи Jira.");
      const urls = normalizeJiraUrls(baseUrls);
      const cacheKey = JSON.stringify([urls, key]);
      const previous = cache.get(cacheKey);
      if (previous && (previous.pending || (!refresh && previous.expires > Date.now()))) {
        return previous.promise;
      }
      const entry = { pending: true, expires: 0, promise: null };
      entry.promise = Promise.all(urls.map(url => checkJiraIssue(url, key))).then(sites => {
        entry.pending = false;
        const definitive = sites.every(site => site.state === "found" || site.state === "not-found");
        entry.expires = Date.now() + (definitive ? 300000 : 15000);
        return { key, sites, expires: entry.expires };
      });
      if (cache.size >= 500) cache.delete(cache.keys().next().value);
      cache.set(cacheKey, entry);
      return entry.promise;
    },
  };
}
