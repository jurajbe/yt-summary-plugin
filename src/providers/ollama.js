// Local models through Ollama (https://ollama.com). Runs in the service worker.
//
// Three Ollama quirks are handled here:
//  - Ollama answers 403 to browser-extension origins unless OLLAMA_ORIGINS is
//    set. A declarativeNetRequest rule strips the Origin header from this
//    extension's own requests to the configured Ollama server, so no server
//    config is needed. Web pages are unaffected.
//  - Ollama's default context window is small and it silently drops whatever
//    doesn't fit, which would cut off most of a transcript. num_ctx is sized to
//    each request (capped by the user's setting and the model's own limit).
//  - Reasoning models print their thinking; it is kept out of the answer.

import { systemPrompt } from '../prompts.js';
import { buildMessages } from '../messages.js';

export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
export const OLLAMA_CLOUD_URL = 'https://ollama.com';
// Preferred cloud models, best first; the first one the account lists is the default.
export const PREFERRED_CLOUD_MODELS = [/^gpt-oss:120b/, /^deepseek-v3/, /^qwen3(?!-coder)/, /^kimi-k2/, /^glm-4/, /^gpt-oss/];
const ORIGIN_RULE_ID = 1;
const ANSWER_ROOM_TOKENS = 3072;
const MIN_CTX = 8192;

export class OllamaError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export function normalizeBaseUrl(url) {
  let u = (url || '').trim() || DEFAULT_OLLAMA_URL;
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  return new URL(u).origin;
}

let preparedOrigin = null;

/** Strip the Origin header from this extension's requests to the Ollama server. */
export async function prepareOllamaAccess(baseUrl) {
  const origin = normalizeBaseUrl(baseUrl);
  if (preparedOrigin === origin || !chrome.declarativeNetRequest) return;
  // Session rule (tabIds needs one); re-armed before every request, so restarts are fine.
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ORIGIN_RULE_ID],
    addRules: [
      {
        id: ORIGIN_RULE_ID,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
        condition: {
          urlFilter: `|${origin}/`,
          // Only requests the extension's background worker makes; tabs (web
          // pages) keep Ollama's normal origin protection.
          tabIds: [chrome.tabs?.TAB_ID_NONE ?? -1],
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: ['xmlhttprequest', 'other'],
        },
      },
    ],
  });
  preparedOrigin = origin;
}

/** Where requests go: Ollama Cloud (API key) or a local/self-hosted server. */
export function ollamaConnection(settings) {
  if (settings.ollamaMode === 'local') {
    return { base: normalizeBaseUrl(settings.ollamaUrl), cloud: false, headers: {} };
  }
  const key = (settings.ollamaApiKey || '').trim();
  return {
    base: settings.ollamaCloudBaseUrl || OLLAMA_CLOUD_URL, // override exists for tests only
    cloud: true,
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  };
}

/** Default cloud model: the first preferred one the account offers. */
export function pickCloudModel(names) {
  for (const re of PREFERRED_CLOUD_MODELS) {
    const hit = names.find((n) => re.test(n));
    if (hit) return hit;
  }
  return names[0] || 'gpt-oss:120b';
}

async function ollamaFetch(base, path, { cloud = base === OLLAMA_CLOUD_URL, ...init } = {}) {
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
      credentials: 'omit',
    });
  } catch (err) {
    if (init.signal?.aborted) throw err;
    throw new OllamaError(
      cloud
        ? `Can't reach ${base}. Check your internet connection (or Brave Shields / firewall).`
        : `Can't reach Ollama at ${base}. Make sure Ollama is running (open the Ollama app, or run "ollama serve").`,
      'unreachable',
    );
  }
  if (res.ok) return res;

  let detail = '';
  try {
    const body = await res.text();
    detail = JSON.parse(body).error || body;
  } catch {
    // keep it empty
  }
  if (res.status === 401) {
    throw new OllamaError('Ollama Cloud rejected the API key. Check it in the extension settings (ollama.com → Settings → Keys).', 'auth');
  }
  if (res.status === 429) {
    throw new OllamaError(`Ollama Cloud usage limit reached. ${detail ? `(${detail}) ` : ''}Wait a bit, or switch model or provider in settings.`, 'rate-limit');
  }
  if (res.status === 403 && cloud) {
    throw new OllamaError(`Ollama Cloud refused the request (403): ${detail || 'your plan may not include this model'}.`, 'forbidden');
  }
  if (res.status === 403) {
    throw new OllamaError(
      `Ollama at ${base} refused the extension (403). Set the environment variable OLLAMA_ORIGINS=chrome-extension://* and restart Ollama.`,
      'forbidden',
    );
  }
  if (res.status === 404 && /not found/i.test(detail)) {
    const model = JSON.parse(init.body || '{}').model;
    throw new OllamaError(
      model
        ? cloud
          ? `Ollama Cloud doesn't offer "${model}" (any more). Pick another model in settings.`
          : `The model "${model}" isn't installed in Ollama. Run: ollama pull ${model}`
        : detail,
      'model-missing',
    );
  }
  throw new OllamaError(`Ollama error ${res.status}: ${detail || res.statusText}`, 'http');
}

/** Models the server offers (installed models locally, the catalog on Ollama Cloud). */
export async function listModels({ base, cloud, headers }) {
  if (!cloud) await prepareOllamaAccess(base);
  const res = await ollamaFetch(base, '/api/tags', { headers, cloud });
  const { models = [] } = await res.json();
  return models
    .filter((m) => !/embed/i.test(m.name) && !(m.details?.family || '').includes('bert'))
    .map((m) => ({
      name: m.name,
      size: m.size,
      parameterSize: m.details?.parameter_size || '',
      quantization: m.details?.quantization_level || '',
    }));
}

const modelInfoCache = new Map();

/** Context length and capabilities from /api/show (cached per server+model). */
async function modelInfo(base, model, signal) {
  const key = `${base}|${model}`;
  if (modelInfoCache.has(key)) return modelInfoCache.get(key);
  const res = await ollamaFetch(base, '/api/show', { method: 'POST', body: JSON.stringify({ model }), signal });
  const json = await res.json();
  const ctxKey = Object.keys(json.model_info || {}).find((k) => k.endsWith('.context_length'));
  const info = {
    contextLength: ctxKey ? Number(json.model_info[ctxKey]) : null,
    capabilities: json.capabilities || [],
    family: json.details?.family || '',
  };
  modelInfoCache.set(key, info);
  return info;
}

/** Anthropic-style messages → Ollama chat messages (text only). */
export function toOllamaMessages(system, messages) {
  const flatten = (content) =>
    typeof content === 'string'
      ? content
      : content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n\n');
  return [{ role: 'system', content: system }, ...messages.map((m) => ({ role: m.role, content: flatten(m.content) }))];
}

/** Rough token count; errs high (≈3 chars/token) so the context is never too small. */
export function estimateTokens(text) {
  return Math.ceil(text.length / 3);
}

export function chooseNumCtx(promptTokens, { maxContext, modelContext }) {
  const cap = Math.min(maxContext || 32768, modelContext || Infinity);
  const needed = promptTokens + ANSWER_ROOM_TOKENS;
  if (needed > cap) {
    const limitedBy = modelContext && modelContext < maxContext ? "the model's context window" : 'your "Max context" setting';
    throw new OllamaError(
      `This video's transcript is too long for the current setup (needs ~${Math.round(needed / 1000)}k tokens, limit is ${Math.round(cap / 1000)}k from ${limitedBy}). ` +
        (limitedBy.startsWith('your') ? 'Raise "Max context" in settings (uses more memory).' : 'Pick a model with a longer context window.'),
      'too-long',
    );
  }
  const rounded = Math.ceil(Math.max(needed, MIN_CTX) / 4096) * 4096;
  return Math.min(rounded, cap);
}

/** Ollama's `think` value for the chosen effort, or undefined to leave it alone. */
export function thinkSetting(info, model, effort) {
  if (!info?.capabilities?.includes('thinking')) return undefined;
  // gpt-oss takes a level instead of true/false.
  if (/gpt-?oss/i.test(model) || /gptoss/i.test(info.family)) return effort;
  return effort !== 'low';
}

/**
 * Removes <think>…</think> sections from streamed text (older Ollama versions
 * and some models put reasoning inline), even when tags are split across chunks.
 */
export class ThinkFilter {
  constructor() {
    this.buffer = '';
    this.inThink = false;
    this.started = false; // drop leading whitespace before the first visible text
  }

  push(chunk) {
    this.buffer += chunk;
    let out = '';
    for (;;) {
      if (this.inThink) {
        const end = this.buffer.indexOf('</think>');
        if (end === -1) {
          this.buffer = this.buffer.slice(-7); // keep a possible partial closing tag
          return this.emit(out);
        }
        this.buffer = this.buffer.slice(end + 8);
        this.inThink = false;
      } else {
        const start = this.buffer.indexOf('<think>');
        if (start === -1) {
          // Hold back a possible partial "<think>" at the end.
          const lt = this.buffer.lastIndexOf('<');
          const hold = lt !== -1 && '<think>'.startsWith(this.buffer.slice(lt)) ? this.buffer.length - lt : 0;
          out += this.buffer.slice(0, this.buffer.length - hold);
          this.buffer = this.buffer.slice(this.buffer.length - hold);
          return this.emit(out);
        }
        out += this.buffer.slice(0, start);
        this.buffer = this.buffer.slice(start + 7);
        this.inThink = true;
      }
    }
  }

  flush() {
    const rest = this.inThink ? '' : this.buffer;
    this.buffer = '';
    return this.emit(rest);
  }

  emit(text) {
    if (!this.started) {
      text = text.replace(/^\s+/, '');
      if (text) this.started = true;
    }
    return text;
  }

  get thinking() {
    return this.inThink;
  }
}

export async function runOllama({ request, settings, signal, emit, cloudModels = [] }) {
  const { base, cloud, headers } = ollamaConnection(settings);
  const messages = toOllamaMessages(systemPrompt(settings.language), buildMessages(request));
  let model;
  let options;
  let think;

  if (cloud) {
    if (!headers.Authorization) {
      throw new OllamaError('Add your Ollama API key in the extension settings first (ollama.com → Settings → Keys).', 'not-configured');
    }
    model = settings.ollamaCloudModel || pickCloudModel(cloudModels.map((m) => m.name));
    // Cloud models run with their full context window; no num_ctx sizing needed.
    if (/gpt-?oss/i.test(model)) think = settings.effort;
  } else {
    model = settings.ollamaModel;
    if (!model) throw new OllamaError('Pick an Ollama model in the extension settings first.', 'not-configured');
    await prepareOllamaAccess(base);
    const info = await modelInfo(base, model, signal).catch((err) => {
      if (err instanceof OllamaError && err.code !== 'http') throw err;
      return null; // older Ollama without /api/show details: carry on
    });
    options = {
      num_ctx: chooseNumCtx(estimateTokens(messages.map((m) => m.content).join('\n')), {
        maxContext: Number(settings.ollamaMaxContext) || 32768,
        modelContext: info?.contextLength,
      }),
    };
    think = thinkSetting(info, model, settings.effort);
  }

  emit({ type: 'status', text: cloud ? `Asking ${model}…` : `Loading ${model}…` });
  const res = await ollamaFetch(base, '/api/chat', {
    method: 'POST',
    signal,
    headers,
    cloud,
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      ...(think !== undefined ? { think } : {}),
      ...(options ? { options } : {}),
    }),
  });

  const filter = new ThinkFilter();
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let pending = '';
  let text = '';
  let doneReason = '';
  let announcedThinking = false;

  const handleLine = (line) => {
    if (!line.trim()) return;
    const obj = JSON.parse(line);
    if (obj.error) throw new OllamaError(`Ollama: ${obj.error}`, 'stream');
    const thinkingNow = Boolean(obj.message?.thinking) || filter.thinking;
    if (thinkingNow && !announcedThinking) {
      announcedThinking = true;
      emit({ type: 'status', text: `${model} is thinking…` });
    }
    const visible = filter.push(obj.message?.content || '');
    if (visible) {
      text += visible;
      emit({ type: 'delta', text: visible });
    }
    if (obj.done) doneReason = obj.done_reason || 'stop';
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop();
    lines.forEach(handleLine);
  }
  handleLine(pending);
  const rest = filter.flush();
  if (rest) {
    text += rest;
    emit({ type: 'delta', text: rest });
  }

  return {
    text,
    content: [{ type: 'text', text: text || '(no answer)' }],
    truncated: doneReason === 'length',
    model,
    modelLabel: `${model} · Ollama${cloud ? ' Cloud' : ''}`,
  };
}

export function describeOllamaError(err) {
  return err?.message || String(err);
}
