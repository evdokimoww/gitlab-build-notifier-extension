document.getElementById("opts").addEventListener("click", (e) => {
  e.preventDefault();
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  }
});

chrome.storage.local.get({ pollIntervalSec: 25, gitlabBaseUrl: "" }, (s) => {
  const el = document.getElementById("line");
  if (el) el.textContent = `База: ${s.gitlabBaseUrl || "(не задана)"}. Опрос каждые ${s.pollIntervalSec} с.`;
});
