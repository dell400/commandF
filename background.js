// Toolbar icon opens the side panel.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// Keyboard shortcut opens the side panel. open() must run synchronously
// inside the listener, so it keeps the user gesture.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "open-deep-find" && tab) {
    chrome.sidePanel.open({ windowId: tab.windowId });
  }
});
