import { JIRA_DEFAULTS, createJiraResolver, normalizeBaseUrl, normalizeJiraUrls } from "./jira-api.js";
import { installJiraLinks } from "./jira-links.js";

/** Keep Jira link checks independent of the GitLab token, CI polling and project whitelist. */
export function initializeJiraLinks() {
  const resolver = createJiraResolver();
  const defaults = { gitlabBaseUrl: "https://git-02.t1-group.ru", ...JIRA_DEFAULTS };
  let settingsRevision = 0;

  async function settings() {
    const saved = await chrome.storage.local.get(defaults);
    return { ...saved, gitlabBaseUrl: normalizeBaseUrl(saved.gitlabBaseUrl),
      jiraBaseUrls: normalizeJiraUrls(saved.jiraBaseUrls) };
  }

  function isGitlabTab(tab, config) {
    try {
      const url = new URL(tab.url);
      const base = new URL(config.gitlabBaseUrl);
      return url.origin === base.origin &&
        (url.pathname === base.pathname || url.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`));
    } catch { return false; }
  }

  async function inject(tabs, previousBaseUrl) {
    const revision = settingsRevision;
    const config = await settings();
    const candidates = tabs ?? await chrome.tabs.query({});
    const allowed = await chrome.permissions.contains({ origins: [`${new URL(config.gitlabBaseUrl).origin}/*`] });
    if (revision !== settingsRevision) return inject(tabs, previousBaseUrl);
    if (previousBaseUrl && previousBaseUrl !== config.gitlabBaseUrl) {
      await Promise.all(candidates.filter(tab => isGitlabTab(tab, { gitlabBaseUrl: previousBaseUrl }))
        .map(tab => chrome.scripting.executeScript({ target: { tabId: tab.id },
          func: installJiraLinks, args: [{ enabled: false, baseUrls: config.jiraBaseUrls }],
        }).catch(() => {})));
    }
    if (revision !== settingsRevision) return inject(tabs, previousBaseUrl);
    if (!allowed) return;
    await Promise.all(candidates.filter(tab => isGitlabTab(tab, config)).map(tab =>
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: installJiraLinks,
        args: [{ enabled: config.enableJiraLinks, baseUrls: config.jiraBaseUrls }],
      }).catch(() => {}),
    ));
  }

  function refresh(tabs, previousBaseUrl) {
    inject(tabs, previousBaseUrl).catch(error => console.warn("[gitlab-notifier] Jira links:", error));
  }

  chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
    if (change.status !== "complete" && !(change.url && tab.status === "complete")) return;
    settings().then(config => {
      if (config.jiraBaseUrls.some(base => tab.url?.startsWith(`${base}/`))) {
        resolver.clear();
        refresh();
      } else {
        refresh([tab]);
      }
    }).catch(() => {});
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !["enableJiraLinks", "jiraBaseUrls", "gitlabBaseUrl"].some(key => changes[key])) return;
    settingsRevision++;
    resolver.clear();
    refresh(undefined, changes.gitlabBaseUrl?.oldValue);
  });
  chrome.permissions.onAdded.addListener(() => { settingsRevision++; resolver.clear(); refresh(); });
  chrome.permissions.onRemoved.addListener(() => { settingsRevision++; resolver.clear(); refresh(); });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== "jira-resolve" && message?.type !== "jira-open") return;
    (async () => {
      const config = await settings();
      if (!config.enableJiraLinks || !sender.tab || !isGitlabTab({ url: sender.url }, config)) {
        throw new Error("Проверка Jira доступна на настроенном GitLab.");
      }
      if (message.type === "jira-resolve") {
        return resolver.resolve(message.key, config.jiraBaseUrls, message.refresh === true);
      }
      const source = new URL(message.sourceUrl);
      const knownLink = config.jiraBaseUrls.some(base => {
        const expected = new URL(`${base}/browse/${message.key}`);
        return source.origin === expected.origin &&
          source.pathname.replace(/\/$/, "").toUpperCase() === expected.pathname.toUpperCase();
      });
      if (!knownLink) throw new Error("Неизвестная ссылка Jira.");
      const result = await resolver.resolve(message.key, config.jiraBaseUrls);
      const found = result.sites.filter(site => site.state === "found");
      if (!found.length) throw new Error("Задача не подтверждена ни в одной Jira. Повторите проверку.");
      for (const [index, site] of found.entries()) {
        const url = new URL(site.url);
        url.search = source.search;
        url.hash = source.hash;
        if (url.origin !== source.origin) {
          for (const key of [...url.searchParams.keys()]) {
            if (key.toLowerCase() === "atlogin") url.searchParams.delete(key);
          }
        }
        await chrome.tabs.create({ url: url.href, windowId: sender.tab.windowId,
          index: sender.tab.index + 1 + index, openerTabId: sender.tab.id,
          active: index === 0 && message.background !== true });
      }
      return { opened: found.length };
    })().then(result => respond({ ok: true, result }))
      .catch(error => respond({ ok: false, error: error.message }));
    return true;
  });
  chrome.runtime.onInstalled.addListener(() => refresh());
  chrome.runtime.onStartup.addListener(() => refresh());
  refresh();
}
