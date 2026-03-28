// MashRoom Test – Background Service Worker
// Opens the full-tab editor when the extension icon is clicked
// (fallback if popup is somehow not defined)

chrome.runtime.onInstalled.addListener(() => {
  console.log('MashRoom Test installed.');
});

// Allow the popup to open the editor tab
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'openEditor') {
    chrome.tabs.create({ url: chrome.runtime.getURL('editor.html') });
    sendResponse({ ok: true });
  }
});
