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
  const signature = build?.images.length ? JSON.stringify(build) : "";
  if (host?.dataset.build === signature) return;
  // A detached widget still has an observer that must be disposed on a new result.
  document.__gitlabBuildImageCleanup?.();
  host?.remove();
  if (!build?.images.length) {
    return;
  }
  let container = document.querySelector("#content-body") || document.querySelector("main");
  if (!container) return;
  host = document.createElement("section");
  host.id = id;
  host.dataset.build = signature;
  host.setAttribute("aria-label", "Готовая сборка");
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { display: block; margin-top: 8px; font: inherit; color: inherit; }
    :host([hidden]) { display: none; }
    .panel { font: inherit; line-height: 1.5; }
    .row { display: flex; gap: 8px; align-items: center; }
    .row + .row { margin-top: 8px; }
    .image { flex: 1; min-width: 0; }
    code { overflow-wrap: anywhere; user-select: text; font-size: 0.875em;
      font-family: var(--gl-font-family-monospace, ui-monospace, monospace); }
    .job { color: inherit; text-decoration: none; }
    .job:hover { color: var(--gl-link-color, #1068bf); text-decoration: underline; }
    button { display: inline-flex; align-items: center; justify-content: center; flex: none;
      min-width: 28px; min-height: 28px; padding: 4px; color: inherit;
      background: transparent; border: 0; border-radius: 4px; font: inherit; cursor: pointer; }
    button:hover { background: var(--gl-button-default-tertiary-background-color-hover, #ececef); }
    svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; }
    .feedback { font-size: 0.875em; color: var(--gl-text-color-secondary, inherit); }
    button:focus-visible, a:focus-visible { outline: 2px solid #1f75cb; outline-offset: 2px; }
  `;
  root.append(style);
  const panel = document.createElement("div");
  panel.className = "panel";
  const projectUrl = `${expected.origin}/${build.projectPath}/-`;
  for (const { image, jobId, jobName } of build.images) {
    const row = document.createElement("div");
    row.className = "row";
    const code = document.createElement("code");
    code.textContent = image;
    const details = document.createElement("div");
    details.className = "image";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.title = "Копировать имя образа";
    copy.setAttribute("aria-label", `Копировать ${image}`);
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 16 16");
    icon.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M5.5 4V2.5h8v8H12 M2.5 5.5h8v8h-8z");
    icon.append(path);
    copy.append(icon);
    const feedback = document.createElement("span");
    feedback.className = "feedback";
    feedback.setAttribute("role", "status");
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(image);
        feedback.textContent = " · Скопировано";
      } catch {
        feedback.textContent = " · Выделите и скопируйте имя";
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(code);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    });
    const job = document.createElement("a");
    job.className = "job";
    job.href = `${projectUrl}/jobs/${jobId}`;
    job.title = `Открыть ${jobName} #${jobId}`;
    job.setAttribute("aria-label", `Образ сборки ${image}, ${jobName} #${jobId}`);
    job.append(code);
    details.append(job, feedback);
    row.append(details, copy);
    panel.append(row);
  }
  root.append(panel);
  function placePanel() {
    container = document.querySelector("#content-body") || document.querySelector("main");
    if (!container) {
      host.remove();
      return;
    }
    const pipelineCard = container.querySelector('[data-testid="pipeline-container"]');
    const matchesPipeline = pipelineCard && Array.from(pipelineCard.querySelectorAll("a[href]"))
      .some((link) => link.href === `${projectUrl}/pipelines/${build.pipelineId}`);
    host.hidden = !matchesPipeline;
    if (pipelineCard) {
      const content = pipelineCard.querySelector(".media-body") || pipelineCard;
      if (host.parentElement !== content) content.append(host);
    } else if (!host.isConnected) {
      container.append(host);
    }
  }
  placePanel();

  // GitLab can navigate between MRs without reloading the document.
  const observer = new MutationObserver(() => {
    if (location.pathname !== expected.pathname) {
      cleanup();
      return;
    }
    // The pipeline widget can finish loading after the API response.
    placePanel();
  });
  function cleanup() {
    observer.disconnect();
    host.remove();
    delete document.__gitlabBuildImageCleanup;
  }
  document.__gitlabBuildImageCleanup = cleanup;
  observer.observe(document.body, {
    childList: true, subtree: true, attributes: true, attributeFilter: ["href"],
  });
}
