import { Backend, type Environment } from './backend';
import { Database } from './database';
import { SYNC_ALARM } from './model';
import type { Command, Reply } from '../shared/types';

const ports = new Set<chrome.runtime.Port>();
const environment: Environment = {
  getLocal: async (key) => (await chrome.storage.local.get(key))[key],
  setLocal: async (key, value) => { await chrome.storage.local.set({ [key]: value }); },
  getSync: () => chrome.storage.sync.get(null),
  setSync: async (items) => { await chrome.storage.sync.set(items); },
  scheduleRetry: async (minutes) => { await chrome.alarms.create(SYNC_ALARM, { delayInMinutes: minutes }); },
  clearRetry: async () => { await chrome.alarms.clear(SYNC_ALARM); },
  changed: () => {
    for (const port of ports) {
      try { port.postMessage({ type: 'changed' }); } catch { ports.delete(port); }
    }
  },
  now: () => Date.now(),
};
const backend = new Backend(new Database(), environment);

function trusted(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    return url.origin === 'https://chatgpt.com' || sender.url.startsWith(chrome.runtime.getURL(''));
  } catch { return false; }
}
chrome.runtime.onMessage.addListener((command: Command, sender, sendResponse: (reply: Reply) => void) => {
  if (!trusted(sender)) { sendResponse({ ok: false, error: '此页面无权访问插件数据。' }); return false; }
  if (command?.type === 'openSettings') {
    chrome.runtime.openOptionsPage().then(
      () => sendResponse({ ok: true, data: null }),
      (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : '无法打开设置页。' }),
    );
    return true;
  }
  backend.dispatch(command).then(
    (data) => sendResponse({ ok: true, data }),
    (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : '操作失败，请稍后重试。' }),
  );
  return true;
});
chrome.runtime.onConnect.addListener((port) => {
  if (!port.sender || !trusted(port.sender)) { port.disconnect(); return; }
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') void backend.receiveRemote(changes).catch(console.error);
});
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === SYNC_ALARM) void backend.flush().catch(console.error); });
chrome.runtime.onInstalled.addListener(() => { void backend.flush().catch(console.error); });
chrome.runtime.onStartup.addListener(() => { void backend.flush().catch(console.error); });
chrome.action.onClicked.addListener(() => { void chrome.runtime.openOptionsPage(); });
// A worker may restart without runtime.onStartup; durable pending operations must resume.
void backend.flush().catch(console.error);
