const OFFSCREEN = "offscreen.html";

chrome.runtime.onInstalled.addListener(async () => {
  // Toolbar icon opens the side panel.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  // Tabs that were already open get the Cmd-F find bar now.
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  for (const tab of tabs) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["findbar.js"] }).catch(() => {});
  }

  // Version 1.0 kept its cache in chrome.storage; it now lives in IndexedDB.
  const all = await chrome.storage.local.get(null);
  const old = Object.keys(all).filter((k) => /^v\d+:/.test(k));
  if (old.length) chrome.storage.local.remove(old);
});

// The offscreen document downloads linked pages and runs OCR for the find bar.
let creating = null;
async function ensureWorker() {
  const url = chrome.runtime.getURL(OFFSCREEN);
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
  if (existing.length) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN,
      reasons: ["WORKERS", "DOM_PARSER"],
      justification: "Download linked pages and PDFs and read their text (OCR) for the find bar.",
    })
    .finally(() => (creating = null));
  await creating;
}

// open() must run synchronously inside the listener so the user gesture still counts.
function openPanel(windowId, query) {
  chrome.sidePanel.open({ windowId }).catch(() => {});
  if (!query) return;
  chrome.storage.session.set({ pendingQuery: query }).catch(() => {});
  chrome.runtime.sendMessage({ type: "deep-find-run", query }).catch(() => {}); // panel already open
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "open-deep-find" && tab) openPanel(tab.windowId, "");
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "deep-find-worker") {
    ensureWorker().then(() => sendResponse(true), () => sendResponse(false));
    return true; // async response
  }
  if (msg?.type === "deep-find-panel" && sender.tab) openPanel(sender.tab.windowId, msg.query || "");
});
