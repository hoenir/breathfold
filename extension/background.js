// Service workers have no Web Bluetooth, so the band lives in the monitor page (a pinned tab).
// This worker only keeps that tab around and handles notification clicks.
const MONITOR = chrome.runtime.getURL('monitor.html');
const APP = 'https://sandervandecruys.be/breathfold/?pattern=adaptive';

async function ensureMonitor(focus) {
  const [tab] = await chrome.tabs.query({ url: MONITOR });
  if (tab) {
    if (focus) { await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); }
    return tab;
  }
  return chrome.tabs.create({ url: MONITOR, pinned: true, active: !!focus });
}

// open the monitor whenever Chrome starts; it takes a fresh baseline from the first five minutes of data
chrome.runtime.onStartup.addListener(() => ensureMonitor(false));
chrome.runtime.onInstalled.addListener(() => ensureMonitor(true));
chrome.action.onClicked.addListener(() => ensureMonitor(true));

async function openApp() {
  const [tab] = await chrome.tabs.query({ url: 'https://sandervandecruys.be/breathfold/*' });
  if (tab) {                               // already open: just bring it forward, a reload would end a running session
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else chrome.tabs.create({ url: APP });
}

// tell the monitor page what happened to a suggestion, for the day's history
const report = (id, what) => {
  const t = +id.split('-')[1];
  if (t) chrome.runtime.sendMessage({ alert: t, what }).catch(() => {});
};

chrome.notifications.onClicked.addListener(id => {
  chrome.notifications.clear(id);
  if (id === 'reconnect') return ensureMonitor(true);
  report(id, 'opened');
  openApp();
});
chrome.notifications.onButtonClicked.addListener(async (id, i) => {
  chrome.notifications.clear(id);
  if (id === 'reconnect') return ensureMonitor(true);
  if (i === 0) { report(id, 'opened'); return openApp(); }
  report(id, 'snoozed');
  await chrome.storage.local.set({ snoozeUntil: Date.now() + 60 * 60 * 1000 });   // "Not now": quiet for an hour
});
