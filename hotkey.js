// Runs on every page. Catches Cmd-F (Ctrl-F off the Mac) before Chrome's find
// bar and asks the background to open Deep Find. The panel switch
// "Cmd-F opens Deep Find" turns this off.
(() => {
  if (window.__deepFindHotkey) return; // injected twice (install + manifest)
  window.__deepFindHotkey = true;

  const isMac = /Mac/i.test(navigator.platform || navigator.userAgent);
  let enabled = true;

  const load = () =>
    chrome.storage.local.get("settings").then(({ settings }) => {
      enabled = settings?.takeOverFind ?? true;
    }).catch(() => {});
  load();
  chrome.storage.onChanged.addListener((c) => { if (c.settings) load(); });

  window.addEventListener("keydown", (e) => {
    if (!enabled) return;
    const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (!mod || e.shiftKey || e.altKey || e.key.toLowerCase() !== "f") return;
    let selection = "";
    try { selection = String(getSelection()).trim().slice(0, 100); } catch {}
    try {
      chrome.runtime.sendMessage({ type: "deep-find-open", selection });
    } catch {
      return; // extension was reloaded; let Chrome's find bar open
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
})();
