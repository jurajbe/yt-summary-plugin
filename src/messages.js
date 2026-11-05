import { MODES, videoContextText } from './prompts.js';

export function buildMessages(request) {
  const contextBlock = {
    type: 'text',
    text: videoContextText(request.video),
    // Cache the transcript: the three summary modes and every follow-up reuse it.
    cache_control: { type: 'ephemeral' },
  };

  if (request.kind === 'summary') {
    const mode = MODES[request.mode];
    if (!mode) throw new Error(`Unknown mode: ${request.mode}`);
    return [{ role: 'user', content: [contextBlock, { type: 'text', text: mode.instruction }] }];
  }

  if (request.kind === 'chat') {
    const [first, ...rest] = request.turns;
    return [
      { role: 'user', content: [contextBlock, { type: 'text', text: first.content }] },
      ...rest.map((t, i) => {
        const expected = i % 2 === 0 ? 'assistant' : 'user';
        if (t.role !== expected) throw new Error('Chat history out of order');
        return { role: t.role, content: t.content };
      }),
    ];
  }

  throw new Error(`Unknown request kind: ${request.kind}`);
}

/** Text the user sees: the text blocks after the last fallback switch point. */
export function finalText(content) {
  const lastFallback = findLastIndex(content, (b) => b.type === 'fallback');
  return content
    .slice(lastFallback + 1)
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/**
 * Assistant content to send back on the next turn. Thinking blocks are echoed
 * unchanged; after a mid-output fallback, model-internal blocks from the
 * declined attempt (before the last fallback block) are dropped.
 */
export function echoableContent(content) {
  const lastFallback = findLastIndex(content, (b) => b.type === 'fallback');
  const internal = new Set(['thinking', 'redacted_thinking', 'tool_use', 'server_tool_use']);
  const kept = content.filter((b, i) => {
    if (b.type === 'fallback') return false;
    if (i < lastFallback && internal.has(b.type)) return false;
    return true;
  });
  // A history turn must not be empty.
  return kept.length ? kept : [{ type: 'text', text: '(no answer)' }];
}

function findLastIndex(arr, pred) {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}
