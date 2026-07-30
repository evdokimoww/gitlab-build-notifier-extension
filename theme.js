const THEME_STORAGE_KEY = "uiTheme";
const darkModeQuery = globalThis.matchMedia?.("(prefers-color-scheme: dark)");

function resolveTheme(theme) {
  if (theme === "light" || theme === "dark") return theme;
  return darkModeQuery?.matches ? "dark" : "light";
}

function applyTheme(theme) {
  const resolved = resolveTheme(theme);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  globalThis.dispatchEvent(
    new CustomEvent("ui-theme-change", {
      detail: { theme: resolved },
    }),
  );
}

if (globalThis.chrome?.storage?.local) {
  chrome.storage.local.get({ [THEME_STORAGE_KEY]: "system" }, (settings) => {
    applyTheme(settings[THEME_STORAGE_KEY]);
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[THEME_STORAGE_KEY]) return;
    applyTheme(changes[THEME_STORAGE_KEY].newValue);
  });
} else {
  applyTheme("system");
}
