import { extractJobBuildImage } from "./gitlab-promote.js";

/** Cache only extracted image names; failed reads are retried on the next poll. */
export async function getBuildImages(apiBase, token, projectPath, jobs) {
  const { mrBuildImages = {} } = await chrome.storage.session.get("mrBuildImages");
  const images = [];
  for (const job of jobs) {
    if (String(job.status).trim().toLowerCase() !== "success") continue;
    const key = `${apiBase}|${projectPath}|${job.id}`;
    try {
      const image = mrBuildImages[key] || await extractJobBuildImage(
        apiBase, token, projectPath, Number(job.id),
      );
      mrBuildImages[key] = image;
      images.push({ image, jobId: job.id, jobName: String(job.name || job.stage) });
    } catch {
      // A missing artifact or trace must not prevent the stage notification.
    }
  }
  await chrome.storage.session.set({
    mrBuildImages: Object.fromEntries(Object.entries(mrBuildImages).slice(-100)),
  });
  return images;
}

/** Inject into the captured MR URL only, so a slow request cannot update another page. */
export async function showMrBuildImages(tabs, build) {
  await Promise.all(tabs.map(async ({ id, url }) => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: id },
        func: renderMrBuildImages,
        args: [url, build],
      });
    } catch {
      // The tab may have closed or navigated while GitLab was responding.
    }
  }));
}

/** Self-contained content script: only display data is passed into the page. */
export function renderMrBuildImages(expectedUrl, build) {
  const expected = new URL(expectedUrl);
  if (location.origin !== expected.origin || location.pathname !== expected.pathname) return;
  const id = "gitlab-notifier-build-image";
  let host = document.getElementById(id);
  if (!build?.images.length) {
    host?.remove();
    return;
  }
  const signature = JSON.stringify(build);
  if (host?.dataset.build === signature) return;
  host?.remove();
  const container = document.querySelector("#content-body") || document.querySelector("main");
  if (!container) return;
  host = document.createElement("section");
  host.id = id;
  host.dataset.build = signature;
  host.setAttribute("aria-label", "Готовая сборка");
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { display: block; margin: 12px 0 16px; color: var(--gl-text-color, #333238); }
    .panel { padding: 12px 16px; border: 1px solid var(--gl-border-color, #bfbfc3);
      border-left: 3px solid #108548; border-radius: 6px;
      background: var(--gl-background-color-default, #fff); font: 14px/1.5 sans-serif; }
    .heading { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
    .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
    code { flex: 1 1 280px; overflow-wrap: anywhere; user-select: text; font-size: 13px; }
    a { color: var(--gl-link-color, #1068bf); text-decoration: underline; }
    button { color: inherit; background: transparent; border: 1px solid var(--gl-border-color, #bfbfc3);
      border-radius: 4px; padding: 4px 10px; font: inherit; cursor: pointer; }
    button:focus-visible, a:focus-visible { outline: 2px solid #1f75cb; outline-offset: 2px; }
  `;
  root.append(style);
  const panel = document.createElement("div");
  panel.className = "panel";
  const heading = document.createElement("div");
  heading.className = "heading";
  const title = document.createElement("strong");
  title.textContent = `Сборка готова · ${build.stageName}`;
  const projectUrl = `${expected.origin}/${build.projectPath}/-`;
  const pipeline = document.createElement("a");
  pipeline.href = `${projectUrl}/pipelines/${build.pipelineId}`;
  pipeline.textContent = `Pipeline #${build.pipelineId}`;
  heading.append(title, pipeline);
  panel.append(heading);
  for (const { image, jobId, jobName } of build.images) {
    const row = document.createElement("div");
    row.className = "row";
    const code = document.createElement("code");
    code.textContent = image;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Копировать";
    copy.setAttribute("aria-label", `Копировать ${image}`);
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(image);
        copy.textContent = "Скопировано";
      } catch {
        copy.textContent = "Выделите и скопируйте имя";
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(code);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    });
    const job = document.createElement("a");
    job.href = `${projectUrl}/jobs/${jobId}`;
    job.textContent = `${jobName} #${jobId}`;
    row.append(code, copy, job);
    panel.append(row);
  }
  root.append(panel);
  const header = container.querySelector(".detail-page-header");
  if (header) header.after(host);
  else container.prepend(host);

  // GitLab can navigate between MRs without reloading the document.
  const observer = new MutationObserver(() => {
    if (!host.isConnected || location.pathname !== expected.pathname) {
      host.remove();
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
