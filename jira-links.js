/** Injected in GitLab's isolated world; all dependencies must stay inside this function. */
export function installJiraLinks({ enabled, baseUrls }) {
  document.__gitlabJiraCleanup?.();
  if (!enabled) return;

  const bases = baseUrls.map(value => new URL(value));
  const links = new Map();
  const results = new Map();
  const pending = new Map();
  let stopped = false;
  let panel;
  let queued = false;
  let running = 0;
  const queue = [];

  function issueKey(link) {
    try {
      const url = new URL(link.href);
      for (const base of bases) {
        const prefix = `${base.pathname.replace(/\/$/, "")}/browse/`;
        if (url.origin !== base.origin || !url.pathname.startsWith(prefix)) continue;
        const key = url.pathname.slice(prefix.length).replace(/\/$/, "").toUpperCase();
        if (/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) return key;
      }
    } catch { /* Ignore unrelated links. */ }
    return null;
  }

  /** Preserve comment navigation without sending the source Jira's auto-login to another Jira. */
  function destinationUrl(href, originalHref) {
    const url = new URL(href);
    const source = new URL(originalHref);
    url.search = source.search;
    url.hash = source.hash;
    if (url.origin !== source.origin) {
      for (const key of [...url.searchParams.keys()]) {
        if (key.toLowerCase() === "atlogin") url.searchParams.delete(key);
      }
    }
    return url.href;
  }

  function rememberLink(link, key) {
    if (!links.has(link)) links.set(link, { key, href: link.href,
      appliedHref: link.href, title: link.getAttribute("title"), target: link.getAttribute("target"), rel: link.getAttribute("rel") });
    const original = links.get(link);
    if (link.href !== original.appliedHref) original.href = original.appliedHref = link.href;
    link.target = "_blank";
    link.relList.add("noopener", "noreferrer");
  }

  function applyResult(key, result) {
    if (stopped) return;
    results.set(key, result);
    const found = result.sites.filter(site => site.state === "found");
    for (const [link, original] of links) {
      if (!link.isConnected) { links.delete(link); continue; }
      if (original.key !== key || issueKey(link) !== key) continue;
      rememberLink(link, key);
      if (found.length === 1) {
        const href = destinationUrl(found[0].url, original.href);
        if (link.href !== href) link.href = href;
        link.title = `${key}: ${new URL(found[0].baseUrl).host}`;
      } else {
        if (link.href !== original.href) link.href = original.href;
        link.title = found.length > 1
          ? `${key} есть в обеих Jira. Нажмите, чтобы открыть обе.`
          : `${key}: не удалось подтвердить задачу. Нажмите для проверки.`;
      }
      original.appliedHref = link.href;
    }
  }

  function drain() {
    while (!stopped && running < 3 && queue.length) {
      const job = queue.shift();
      running++;
      chrome.runtime.sendMessage({ type: "jira-resolve", key: job.key, refresh: job.refresh })
        .then(response => {
          if (!response?.ok) throw new Error(response?.error || "Обновите страницу GitLab.");
          applyResult(job.key, response.result);
          job.resolve(response.result);
        })
        .catch(job.reject)
        .finally(() => { running--; pending.delete(job.key); drain(); });
    }
  }

  function resolve(key, refresh = false) {
    if (pending.has(key)) return pending.get(key);
    const result = results.get(key);
    if (!refresh && result?.expires > Date.now()) return Promise.resolve(result);
    const promise = new Promise((resolve, reject) => queue.push({ key, refresh, resolve, reject }));
    pending.set(key, promise);
    drain();
    return promise;
  }

  function scan() {
    queued = false;
    if (stopped) return;
    for (const [link, original] of links) {
      if (!link.isConnected || issueKey(link) !== original.key) links.delete(link);
    }
    for (const link of document.querySelectorAll("a[href]")) {
      const key = issueKey(link);
      if (!key || links.get(link)?.appliedHref === link.href) continue;
      rememberLink(link, key);
      link.title = `${key}: проверяем обе Jira…`;
      resolve(key).then(result => applyResult(key, result)).catch(() => {
        if (!stopped) link.title = "Проверка Jira недоступна. Обновите страницу GitLab.";
      });
    }
  }

  function closePanel() { panel?.remove(); panel = undefined; }

  async function showPanel(link, key, { refresh = false, openOnResolve = false, background = false } = {}) {
    closePanel();
    const sourceUrl = links.get(link)?.href || link.href;
    const host = document.createElement("div");
    panel = host;
    host.id = "gitlab-notifier-jira-choice";
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { position: fixed; z-index: 2147483647; color-scheme: light dark; }
      .box { width: min(360px, calc(100vw - 24px)); padding: 16px; border: 1px solid #888;
        border-radius: 8px; background: Canvas; color: CanvasText; box-shadow: 0 4px 20px #0004;
        font: 14px/1.5 system-ui, sans-serif; overflow-wrap: anywhere; }
      a { display: block; margin: 8px 0; color: LinkText; }
      p { margin: 8px 0; }
      button { cursor: pointer; padding: 5px 10px; margin-right: 8px; }
      :focus-visible { outline: 2px solid #1f75cb; outline-offset: 2px; }
    `;
    const box = document.createElement("div");
    box.className = "box";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", `Задача ${key} в Jira`);
    const heading = document.createElement("strong");
    heading.textContent = key;
    const content = document.createElement("div");
    content.setAttribute("aria-live", "polite");
    content.textContent = "Проверяем обе Jira…";
    const retry = document.createElement("button");
    retry.textContent = "Проверить снова";
    retry.addEventListener("click", () => showPanel(link, key, { refresh: true, openOnResolve, background }));
    const close = document.createElement("button");
    close.textContent = "Закрыть";
    close.addEventListener("click", () => { closePanel(); link.focus(); });
    box.append(heading, content, retry, close);
    root.append(style, box);
    const rect = link.getBoundingClientRect();
    host.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - 384))}px`;
    host.style.top = `${Math.max(12, Math.min(rect.bottom + 8, innerHeight - 360))}px`;
    host.style.maxHeight = "calc(100vh - 24px)";
    host.style.overflow = "auto";
    document.documentElement.append(host);
    close.focus();
    try {
      const result = await resolve(key, refresh);
      if (stopped || panel !== host) return;
      content.replaceChildren();
      const found = result.sites.filter(site => site.state === "found");
      if (openOnResolve && found.length) {
        const response = await chrome.runtime.sendMessage({ type: "jira-open", key,
          sourceUrl, background });
        if (!response?.ok) throw new Error(response?.error || "Не удалось открыть задачу. Обновите страницу GitLab.");
        if (panel === host) closePanel();
        return;
      }
      const note = document.createElement("p");
      note.textContent = found.length > 1 ? "Задача есть в обеих Jira. Выберите адрес."
        : found.length === 1 ? "Задача найдена. Можно перейти."
        : "Не удалось подтвердить задачу ни в одной Jira.";
      content.append(note);
      for (const site of result.sites) {
        const row = document.createElement(site.state === "found" || site.state === "login" ? "a" : "p");
        const name = new URL(site.baseUrl).host;
        if (site.state === "found") {
          row.href = destinationUrl(site.url, links.get(link)?.href || link.href);
          row.target = "_blank";
          row.rel = "noopener noreferrer";
          row.textContent = `Открыть ${key} в ${name}`;
        } else if (site.state === "login") {
          row.href = site.baseUrl;
          row.target = "_blank";
          row.rel = "noopener noreferrer";
          row.textContent = `Войти в ${name}`;
        } else {
          row.textContent = `${name}: ${site.message}`;
          if (site.state === "not-found" || site.state === "forbidden") {
            const login = document.createElement("a");
            login.href = site.baseUrl;
            login.target = "_blank";
            login.rel = "noopener noreferrer";
            login.textContent = "Открыть Jira / войти";
            row.append(login);
          }
        }
        content.append(row);
      }
    } catch (error) {
      if (!stopped && panel === host) content.textContent = error.message;
    }
  }

  function intercept(event) {
    if (panel && event.composedPath().includes(panel)) return;
    const link = event.target.closest?.("a[href]");
    const key = link && issueKey(link);
    if (!key || (event.type === "auxclick" && event.button !== 1)) return;
    rememberLink(link, key);
    const result = results.get(key);
    if (result?.expires > Date.now() && result.sites.filter(site => site.state === "found").length === 1) {
      applyResult(key, result);
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    showPanel(link, key, { openOnResolve: event.type !== "contextmenu",
      background: event.button === 1 || event.ctrlKey || event.metaKey });
  }

  function dismiss(event) {
    if (event.key === "Escape" || (event.type === "pointerdown" && !event.composedPath().includes(panel))) {
      closePanel();
    }
  }

  const observer = new MutationObserver(() => {
    if (!queued) { queued = true; queueMicrotask(scan); }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
  for (const type of ["click", "auxclick", "contextmenu"]) document.addEventListener(type, intercept, true);
  document.addEventListener("keydown", dismiss);
  document.addEventListener("pointerdown", dismiss);
  document.__gitlabJiraCleanup = () => {
    stopped = true;
    observer.disconnect();
    closePanel();
    for (const type of ["click", "auxclick", "contextmenu"]) document.removeEventListener(type, intercept, true);
    document.removeEventListener("keydown", dismiss);
    document.removeEventListener("pointerdown", dismiss);
    for (const [link, original] of links) {
      if (issueKey(link) !== original.key) continue;
      link.href = original.href;
      for (const attribute of ["title", "target", "rel"]) {
        if (original[attribute] === null) link.removeAttribute(attribute);
        else link.setAttribute(attribute, original[attribute]);
      }
    }
    delete document.__gitlabJiraCleanup;
  };
  scan();
}
