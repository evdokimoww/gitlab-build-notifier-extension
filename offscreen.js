const DEFAULT_SOUND_URL = chrome.runtime.getURL("sounds/notify.wav");

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "PLAY_GITLAB_CI_SOUND") return;
  const vol = typeof msg.volume === "number" ? msg.volume : 0.4;
  const url =
    typeof msg.soundUrl === "string" && msg.soundUrl.startsWith("chrome-extension://")
      ? msg.soundUrl
      : DEFAULT_SOUND_URL;
  const audio = new Audio(url);
  audio.volume = Math.min(1, Math.max(0, vol));
  audio
    .play()
    .then(() => sendResponse({ ok: true }))
    .catch((e) => {
      console.warn("[gitlab-notifier offscreen] play:", e);
      sendResponse({ ok: false, error: String(e) });
    });
  return true;
});
