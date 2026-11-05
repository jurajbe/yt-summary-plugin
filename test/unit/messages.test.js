import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, echoableContent, finalText } from '../../src/messages.js';
import { MODES, systemPrompt } from '../../src/prompts.js';

const video = { title: 'How to X', channel: 'Chan', durationSeconds: 125, description: 'desc', transcript: '[0:00] hi' };

test('summary request: cached video context first, mode instruction after', () => {
  const [msg, ...rest] = buildMessages({ kind: 'summary', mode: 'tldr', video });
  assert.equal(rest.length, 0);
  assert.equal(msg.role, 'user');
  assert.deepEqual(msg.content[0].cache_control, { type: 'ephemeral' });
  assert.match(msg.content[0].text, /<title>How to X<\/title>/);
  assert.match(msg.content[0].text, /<duration>2:05<\/duration>/);
  assert.match(msg.content[0].text, /\[0:00\] hi/);
  assert.equal(msg.content[1].text, MODES.tldr.instruction);
});

test('the transcript block is byte-identical across modes and chat (prompt cache prefix)', () => {
  const a = buildMessages({ kind: 'summary', mode: 'tldr', video })[0].content[0];
  const b = buildMessages({ kind: 'summary', mode: 'deep', video })[0].content[0];
  const c = buildMessages({ kind: 'chat', video, turns: [{ role: 'user', content: 'q' }] })[0].content[0];
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
});

test('chat request echoes assistant content unchanged', () => {
  const assistant = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'a1' }];
  const msgs = buildMessages({
    kind: 'chat',
    video,
    turns: [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: assistant },
      { role: 'user', content: 'q2' },
    ],
  });
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].content[1].text, 'q1');
  assert.deepEqual(msgs[1], { role: 'assistant', content: assistant });
  assert.deepEqual(msgs[2], { role: 'user', content: 'q2' });
});

test('chat request rejects out-of-order history', () => {
  assert.throws(() =>
    buildMessages({ kind: 'chat', video, turns: [{ role: 'user', content: 'q' }, { role: 'user', content: 'q' }] }),
  );
});

test('unknown mode throws', () => {
  assert.throws(() => buildMessages({ kind: 'summary', mode: 'nope', video }));
});

test('finalText ignores text from a declined attempt before a fallback', () => {
  const content = [
    { type: 'text', text: 'partial from first model' },
    { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } },
    { type: 'text', text: 'answer' },
  ];
  assert.equal(finalText(content), 'answer');
  assert.equal(finalText([{ type: 'thinking', thinking: '' }, { type: 'text', text: 'x' }, { type: 'text', text: 'y' }]), 'xy');
});

test('echoableContent drops model-internal blocks before the last fallback, keeps thinking otherwise', () => {
  const thinking = { type: 'thinking', thinking: '', signature: 's' };
  assert.deepEqual(echoableContent([thinking, { type: 'text', text: 'a' }]), [thinking, { type: 'text', text: 'a' }]);
  const after = { type: 'thinking', thinking: '', signature: 't' };
  assert.deepEqual(
    echoableContent([thinking, { type: 'text', text: 'p' }, { type: 'fallback' }, after, { type: 'text', text: 'b' }]),
    [{ type: 'text', text: 'p' }, after, { type: 'text', text: 'b' }],
  );
  assert.deepEqual(echoableContent([]), [{ type: 'text', text: '(no answer)' }]);
});

test('system prompt names the answer language and is stable', () => {
  assert.match(systemPrompt('Slovak'), /Write your answer in Slovak/);
  assert.equal(systemPrompt('English'), systemPrompt('English'));
});
