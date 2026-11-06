import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ThinkFilter,
  chooseNumCtx,
  estimateTokens,
  normalizeBaseUrl,
  ollamaConnection,
  pickCloudModel,
  thinkSetting,
  toOllamaMessages,
} from '../../src/providers/ollama.js';

test('ThinkFilter strips <think> blocks even when tags are split across chunks', () => {
  const f = new ThinkFilter();
  const chunks = ['<thi', 'nk>secret plan', ' more</th', 'ink>\n\n**The point:**', ' do X <b>', 'old</b> a<b'];
  const out = chunks.map((c) => f.push(c)).join('') + f.flush();
  assert.equal(out, '**The point:** do X <b>old</b> a<b');
});

test('ThinkFilter passes plain text through and drops leading whitespace', () => {
  const f = new ThinkFilter();
  assert.equal(f.push('\n  Hello'), 'Hello');
  assert.equal(f.push(' world'), ' world');
  assert.equal(f.flush(), '');
});

test('ThinkFilter drops an unterminated think block', () => {
  const f = new ThinkFilter();
  assert.equal(f.push('<think>still thinking'), '');
  assert.equal(f.thinking, true);
  assert.equal(f.flush(), '');
});

test('chooseNumCtx sizes the window to the prompt, within limits', () => {
  assert.equal(chooseNumCtx(1000, { maxContext: 32768 }), 8192); // minimum
  assert.equal(chooseNumCtx(10000, { maxContext: 32768 }), 16384); // 13072 rounded up to 4k steps
  assert.equal(chooseNumCtx(28000, { maxContext: 32768, modelContext: 131072 }), 32768);
  assert.throws(() => chooseNumCtx(40000, { maxContext: 32768 }), /Raise "Max context"/);
  assert.throws(() => chooseNumCtx(10000, { maxContext: 65536, modelContext: 8192 }), /longer context window/);
});

test('estimateTokens errs high', () => {
  assert.equal(estimateTokens('a'.repeat(3000)), 1000);
});

test('toOllamaMessages flattens Anthropic-style blocks to text', () => {
  const msgs = toOllamaMessages('sys', [
    { role: 'user', content: [{ type: 'text', text: 'ctx', cache_control: {} }, { type: 'text', text: 'q' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'a' }] },
    { role: 'user', content: 'q2' },
  ]);
  assert.deepEqual(msgs, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'ctx\n\nq' },
    { role: 'assistant', content: 'a' },
    { role: 'user', content: 'q2' },
  ]);
});

test('thinkSetting maps effort per model type', () => {
  const thinking = { capabilities: ['completion', 'thinking'], family: 'qwen3' };
  assert.equal(thinkSetting(thinking, 'qwen3:8b', 'low'), false);
  assert.equal(thinkSetting(thinking, 'qwen3:8b', 'high'), true);
  assert.equal(thinkSetting({ capabilities: ['thinking'], family: 'gptoss' }, 'gpt-oss:20b', 'medium'), 'medium');
  assert.equal(thinkSetting({ capabilities: ['completion'] }, 'gemma3:12b', 'high'), undefined);
  assert.equal(thinkSetting(null, 'x', 'low'), undefined);
});

test('pickCloudModel prefers strong general models', () => {
  assert.equal(pickCloudModel(['qwen3-coder:480b', 'deepseek-v3.1:671b', 'gpt-oss:120b']), 'gpt-oss:120b');
  assert.equal(pickCloudModel(['qwen3-coder:480b', 'kimi-k2:1t', 'qwen3-vl:235b']), 'qwen3-vl:235b');
  assert.equal(pickCloudModel(['mystery:1b']), 'mystery:1b');
  assert.equal(pickCloudModel([]), 'gpt-oss:120b');
});

test('ollamaConnection: cloud uses ollama.com + bearer key, local uses the server URL', () => {
  assert.deepEqual(ollamaConnection({ ollamaMode: 'cloud', ollamaApiKey: ' k ' }), {
    base: 'https://ollama.com',
    cloud: true,
    headers: { Authorization: 'Bearer k' },
  });
  assert.deepEqual(ollamaConnection({ ollamaMode: 'local', ollamaUrl: '192.168.1.5:11434/' }), {
    base: 'http://192.168.1.5:11434',
    cloud: false,
    headers: {},
  });
  assert.equal(normalizeBaseUrl(''), 'http://localhost:11434');
});
