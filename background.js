// Toolbar icon opens the side panel.
chrome.runtime.onInstalled.addListener(async () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  // Tabs that were already open have no Cmd-F hook yet: add it now.
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  for (const tab of tabs) {
    chrome.scripting
      .executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["hotkey.js"] })
      .catch(() => {});
  }
});

// open() must run synchronously inside the listener so the user gesture
// (shortcut or Cmd-F keypress) still counts.
function openPanel(windowId, selection) {
  chrome.sidePanel.open({ windowId }).catch(() => {});
  // If the panel is already open, it takes focus and the selected text.
  chrome.runtime.sendMessage({ type: "deep-find-focus", selection }).catch(() => {});
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "open-deep-find" && tab) openPanel(tab.windowId, "");
});

// Cmd-F on a page (from hotkey.js).
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "deep-find-open" && sender.tab) openPanel(sender.tab.windowId, msg.selection || "");
});
