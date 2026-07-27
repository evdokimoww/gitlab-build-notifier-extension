/**
 * Push-уведомление, звук и мигание favicon — общее для мониторинга CI и promote.
 */

const iconDataUrlCache = new Map();

/** PNG из пакета расширения → data URL (странице нужен свой origin, не chrome-extension://). */
export async function getIconDataUrl(path) {
  const cached = iconDataUrlCache.get(path);
  if (cached) return cached;

  const response = await fetch(chrome.runtime.getURL(path));
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  const dataUrl = `data:image/png;base64,${btoa(binary)}`;
  iconDataUrlCache.set(path, dataUrl);
  return dataUrl;
}

/**
 * Звук в фоне: в service worker нет Audio — используем offscreen; при ошибке — вкладка.
 * @param {number[]} tabIds
 * @param {boolean} success — true: notify.wav, false: notify-fail.wav
 */
export async function playNotificationSound(tabIds, success) {
  const soundSrc = chrome.runtime.getURL(
    success ? "sounds/notify.wav" : "sounds/notify-fail.wav"
  );
  try {
    if (chrome.offscreen?.createDocument) {
      try {
        await chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["AUDIO_PLAYBACK"],
          justification:
            "Воспроизведение звука при завершении stage CI GitLab (уведомление пользователя).",
        });
      } catch {
        /* документ offscreen уже создан */
      }
      chrome.runtime.sendMessage({
        type: "PLAY_GITLAB_CI_SOUND",
        soundUrl: soundSrc,
      });
      return;
    }
  } catch (e) {
    console.warn("[gitlab-notifier] offscreen sound:", e);
  }
  if (!tabIds.length) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabIds[0] },
      func: (src) => {
        const a = new Audio(src);
        a.volume = 0.4;
        a.play().catch(() => {});
      },
      args: [soundSrc],
    });
  } catch (e) {
    console.warn("[gitlab-notifier] sound через вкладку:", e);
  }
}

/**
 * Runs in page context via executeScript
 * @param {boolean} ok
 * @param {{ enableOverlay?: boolean, enableFaviconTint?: boolean, faviconUrl?: string }} tabFeedback
 */
export async function applyTabFeedback(ok, tabFeedback) {
  const enableOverlay = tabFeedback && tabFeedback.enableOverlay;
  const enableFaviconTint = !tabFeedback || tabFeedback.enableFaviconTint !== false;

  const prefix = ok ? "[CI OK]" : "[CI FAIL]";
  const t = document.title.replace(/^\[(CI OK|CI FAIL|CI …)\]\s*/, "");
  document.title = `${prefix} ${t}`;

  if (enableFaviconTint) {
    const size = 32;
    const fid = "__gitlab_ci_notifier_favicon__";
    const timerKey = "__gitlab_ci_notifier_favicon_iv__";
    const strongUrl = tabFeedback && tabFeedback.faviconUrl;

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

    if (strongUrl) {
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
      if (typeof prevIv === "number") {
        window.clearInterval(prevIv);
      }

      let blinkOn = true;
      let ticks = 0;
      const blinkMs = 450;
      const maxTicks = 28;

      function showFrame() {
        link.href = blinkOn ? strongUrl : softUrl;
        blinkOn = !blinkOn;
        ticks += 1;
        if (ticks >= maxTicks) {
          window.clearInterval(window[timerKey]);
          window[timerKey] = 0;
          link.href = strongUrl;
        }
      }

      showFrame();
      window[timerKey] = window.setInterval(showFrame, blinkMs);
    }
  }

  if (!enableOverlay) return;

  const id = "__gitlab_ci_notifier_bar__";
  let bar = document.getElementById(id);
  if (!bar) {
    bar = document.createElement("div");
    bar.id = id;
    bar.style.cssText = [
      "position:fixed",
      "top:0",
      "left:0",
      "right:0",
      "height:4px",
      "z-index:2147483647",
      "pointer-events:none",
      "transition:opacity 0.4s ease",
    ].join(";");
    document.documentElement.appendChild(bar);
  }
  bar.style.background = ok ? "#0d8050" : "#c03131";
  bar.style.opacity = "1";
  let on = true;
  const iv = window.setInterval(() => {
    on = !on;
    bar.style.opacity = on ? "1" : "0.35";
  }, 600);
  window.setTimeout(() => {
    window.clearInterval(iv);
    bar.style.opacity = "1";
  }, 8000);
}

/**
 * Уведомление, звук и подсветка вкладки.
 * @param {number[]} tabIds
 * @param {{ enableOverlay?: boolean, enableFaviconTint?: boolean, enableNotificationSound?: boolean }} settings
 * @param {{ ok: boolean, title: string, message: string, notifId: string }} payload
 */
export async function deliverCiNotification(tabIds, settings, { ok, title, message, notifId }) {
  const iconUrl = chrome.runtime.getURL(
    ok ? "icons/notify-ok.png" : "icons/notify-fail.png"
  );

  const permission = await new Promise((resolve) => {
    if (chrome.notifications.getPermissionLevel) {
      chrome.notifications.getPermissionLevel(resolve);
    } else {
      resolve("granted");
    }
  });
  if (permission !== "granted") {
    console.warn(
      "[gitlab-notifier] уведомления браузера недоступны (уровень:",
      permission + "). Проверьте настройки уведомлений для Chrome в системе."
    );
  }

  await chrome.notifications.clear(notifId).catch(() => {});

  try {
    await chrome.notifications.create(notifId, {
      type: "basic",
      iconUrl,
      title,
      message,
      priority: 2,
    });
  } catch (e) {
    console.error("[gitlab-notifier] chrome.notifications.create:", e);
    try {
      await chrome.notifications.create({
        type: "basic",
        iconUrl,
        title,
        message,
      });
    } catch (e2) {
      console.error("[gitlab-notifier] повторное создание уведомления:", e2);
    }
  }

  if (settings.enableNotificationSound !== false) {
    await playNotificationSound(tabIds, ok).catch((e) =>
      console.warn("[gitlab-notifier] play sound:", e)
    );
  }

  const faviconPath = ok ? "icons/notify-ok.png" : "icons/notify-fail.png";
  const faviconUrl = await getIconDataUrl(faviconPath);

  for (const tabId of tabIds) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: applyTabFeedback,
        args: [
          ok,
          {
            enableOverlay: settings.enableOverlay,
            enableFaviconTint: settings.enableFaviconTint !== false,
            faviconUrl,
          },
        ],
      });
    } catch (e) {
      console.warn("[gitlab-notifier] tab script:", e);
    }
  }
}

/**
 * Вкладки для визуальной обратной связи: promote.html и страницы проекта на GitLab.
 * @param {string} gitlabBaseUrl
 * @param {string} [projectPath]
 * @returns {Promise<number[]>}
 */
export async function findNotifyTabIds(gitlabBaseUrl, projectPath) {
  const tabs = await chrome.tabs.query({});
  /** @type {number[]} */
  const tabIds = [];
  let origin = "";
  try {
    origin = new URL(String(gitlabBaseUrl || "").replace(/\/$/, "")).origin;
  } catch {
    /* ignore */
  }
  const promotePrefix = chrome.runtime.getURL("promote.html");
  const project = String(projectPath || "").replace(/^\/+|\/+$/g, "");

  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    if (tab.url.startsWith(promotePrefix)) {
      tabIds.push(tab.id);
      continue;
    }
    if (!origin || !project) continue;
    try {
      const u = new URL(tab.url);
      if (u.origin !== origin) continue;
      const path = decodeURIComponent(u.pathname);
      if (path === `/${project}` || path.startsWith(`/${project}/`)) {
        tabIds.push(tab.id);
      }
    } catch {
      /* ignore */
    }
  }
  return [...new Set(tabIds)];
}
