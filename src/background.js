// Service worker: owns the API key and every call to Claude.
// Content scripts talk to it over a long-lived port and receive streamed text.

import Anthropic from '@anthropic-ai/sdk';
import { systemPrompt } from './prompts.js';
import { buildMessages, echoableContent, finalText } from './messages.js';
import { loadSettings, loadPublicSettings } from './settings.js';

// Keep the API key out of reach of content scripts (which run on youtube.com).
chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    const { apiKey } = await loadSettings();
    if (!apiKey) chrome.runtime.openOptionsPage();
  }
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'summarize') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // No "tabs" permission needed: the message only lands where our content script runs.
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'shortcut-summarize' }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'getSettings') {
    loadPublicSettings().then(sendResponse);
    return true; // async response
  }
  if (msg?.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
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
    try {
      await runRequest(msg.request, port, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) return;
      safePost(port, { type: 'error', message: describeError(err) });
    }
  });
  port.onDisconnect.addListener(() => controller?.abort());
});

/**
 * request = { kind: 'summary', mode, video }
 *         | { kind: 'chat', video, turns: [{ role: 'user'|'assistant', content }] }
 * For chat, turns[0] is the first user question (plain text); later assistant
 * turns carry the exact content blocks returned earlier (echoed unchanged).
 */
async function runRequest(request, port, signal) {
  const settings = await loadSettings();
  if (!settings.apiKey) {
    safePost(port, { type: 'error', code: 'no-key', message: 'Add your Anthropic API key in the extension settings first.' });
    return;
  }

  const client = new Anthropic({
    apiKey: settings.apiKey,
    dangerouslyAllowBrowser: true, // the key lives only in this extension's storage, never in the page
    ...(settings.apiBaseUrl ? { baseURL: settings.apiBaseUrl } : {}),
  });

  const messages = buildMessages(request);
  // Haiku 5.5 has no server-side fallback; Opus 5.5 / Sonnet 5.5 retry a policy
  // decline on Anthropic's recommended fallback model instead of failing.
  const supportsFallback = settings.model !== 'claude-haiku-5-5';

  const stream = client.beta.messages.stream(
    {
      model: settings.model,
      max_tokens: 64000,
      system: systemPrompt(settings.language),
      output_config: { effort: settings.effort },
      messages,
      ...(supportsFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    },
    { signal },
  );

  stream.on('text', (text) => safePost(port, { type: 'delta', text }));
  stream.on('contentBlock', (block) => {
    // A fallback block means the original model declined and another model
    // continued. Anything streamed before it was a partial attempt.
    if (block.type === 'fallback') safePost(port, { type: 'fallback', to: block.to?.model });
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category;
    safePost(port, {
      type: 'error',
      code: 'refusal',
      message: `Claude declined to answer this one${category ? ` (${category})` : ''}. Try rephrasing, or another video.`,
    });
    return;
  }

  safePost(port, {
    type: 'done',
    text: finalText(message.content),
    content: echoableContent(message.content),
    truncated: message.stop_reason === 'max_tokens',
    model: message.model,
  });
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Your Anthropic API key was rejected. Check it in the extension settings.';
  if (err instanceof Anthropic.PermissionDeniedError) return `Your API key doesn't have access to this model. Pick another model in settings. (${err.message})`;
  if (err instanceof Anthropic.NotFoundError) return `Model not found — pick another model in settings. (${err.message})`;
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited by the Anthropic API. Wait a moment and try again.';
  if (err instanceof Anthropic.BadRequestError) return `The API rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Anthropic API. Check your connection (or Brave Shields / firewall).';
  if (err instanceof Anthropic.APIError) {
    if (err.status === 529) return 'Claude is overloaded right now. Try again in a minute.';
    return `Anthropic API error${err.status ? ` ${err.status}` : ''}: ${err.message}`;
  }
  return err?.message || String(err);
}

function safePost(port, msg) {
  try {
    port.postMessage(msg);
  } catch {
    // Tab closed or navigated away; nothing to deliver.
  }
}
