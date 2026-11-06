// Service worker: owns the API key and every model call (Claude or Ollama).
// Content scripts talk to it over a long-lived port and receive streamed text.

import { loadSettings, loadPublicSettings } from './settings.js';
import { runAnthropic, describeAnthropicError } from './providers/anthropic.js';
import { runOllama, describeOllamaError, listModels, normalizeBaseUrl, prepareOllamaAccess } from './providers/ollama.js';
import { REFRESH_ALARM, ensureRefreshAlarm, getCachedCloudModels, refreshCloudModels } from './cloudModels.js';

// Keep the API key out of reach of content scripts (which run on youtube.com).
chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
  ensureRefreshAlarm();
  refreshCloudModels().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureRefreshAlarm();
  refreshCloudModels().catch(() => {}); // no-op unless the list is over a day old
});

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM) refreshCloudModels({ force: true }).catch(() => {});
});

// Re-arm the Ollama origin rule whenever the server address changes.
chrome.storage.onChanged.addListener((changes) => {
  if (changes.ollamaUrl) prepareOllamaAccess(changes.ollamaUrl.newValue).catch(() => {});
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'summarize') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // No "tabs" permission needed: the message only lands where our content script runs.
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'shortcut-summarize' }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'getSettings') {
    loadPublicSettings().then(sendResponse);
    return true; // async response
  }
  if (msg?.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
    return false;
  }
  // Only extension pages (the settings page) may probe Ollama.
  const fromExtensionPage = sender.url?.startsWith(chrome.runtime.getURL(''));
  if (msg?.type === 'cloudModels' && fromExtensionPage) {
    refreshCloudModels({ force: Boolean(msg.force), apiKey: typeof msg.apiKey === 'string' ? msg.apiKey : undefined })
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch(async (err) => sendResponse({ ok: false, error: describeOllamaError(err), ...(await getCachedCloudModels()) }));
    return true;
  }
  if (msg?.type === 'ollamaModels' && fromExtensionPage) {
    listModels({ base: normalizeBaseUrl(msg.url), cloud: false, headers: {} })
      .then((models) => sendResponse({ ok: true, models, url: normalizeBaseUrl(msg.url) }))
      .catch((err) => sendResponse({ ok: false, error: describeOllamaError(err) }));
    return true;
  }
  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'claude') return;
  let controller = null;
  port.onMessage.addListener(async (msg) => {
    if (msg?.type === 'abort') {
      controller?.abort();
      return;
    }
    if (msg?.type !== 'run') return;
    controller = new AbortController();
    const signal = controller.signal;
    const settings = await loadSettings();
    const ollama = settings.provider === 'ollama';
    try {
      const run = ollama ? runOllama : runAnthropic;
      const cloudModels = ollama ? (await getCachedCloudModels()).models : [];
      const result = await run({ request: msg.request, settings, signal, cloudModels, emit: (m) => safePost(port, m) });
      safePost(port, { type: 'done', ...result });
    } catch (err) {
      if (signal.aborted) return;
      safePost(port, {
        type: 'error',
        code: err?.code,
        message: ollama ? describeOllamaError(err) : describeAnthropicError(err),
      });
    }
  });
  port.onDisconnect.addListener(() => controller?.abort());
});

function safePost(port, msg) {
  try {
    port.postMessage(msg);
  } catch {
    // Tab closed or navigated away; nothing to deliver.
  }
}
