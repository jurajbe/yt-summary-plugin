// Claude through the Anthropic API (official SDK). Runs in the service worker.

import Anthropic from '@anthropic-ai/sdk';
import { systemPrompt } from '../prompts.js';
import { buildMessages, echoableContent, finalText } from '../messages.js';

export class ProviderError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export async function runAnthropic({ request, settings, signal, emit }) {
  if (!settings.apiKey) {
    throw new ProviderError('Add your Anthropic API key in the extension settings first.', 'not-configured');
  }

  const client = new Anthropic({
    apiKey: settings.apiKey,
    dangerouslyAllowBrowser: true, // the key lives only in this extension's storage, never in the page
    ...(settings.apiBaseUrl ? { baseURL: settings.apiBaseUrl } : {}),
  });

  // Haiku 5.5 has no server-side fallback; Opus 5.5 / Sonnet 5.5 retry a policy
  // decline on Anthropic's recommended fallback model instead of failing.
  const supportsFallback = settings.model !== 'claude-haiku-5-5';

  const stream = client.beta.messages.stream(
    {
      model: settings.model,
      max_tokens: 64000,
      system: systemPrompt(settings.language),
      output_config: { effort: settings.effort },
      messages: buildMessages(request),
      ...(supportsFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    },
    { signal },
  );

  stream.on('text', (text) => emit({ type: 'delta', text }));
  stream.on('contentBlock', (block) => {
    // A fallback block means the original model declined and another model
    // continued. Anything streamed before it was a partial attempt.
    if (block.type === 'fallback') emit({ type: 'fallback', to: block.to?.model });
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category;
    throw new ProviderError(
      `Claude declined to answer this one${category ? ` (${category})` : ''}. Try rephrasing, or another video.`,
      'refusal',
    );
  }

  return {
    text: finalText(message.content),
    content: echoableContent(message.content),
    truncated: message.stop_reason === 'max_tokens',
    model: message.model,
    modelLabel: prettyClaude(message.model),
  };
}

export function prettyClaude(id) {
  const m = /^claude-(\w+)-(\d+)-(\d+)/.exec(id || '');
  return m ? `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id;
}

export function describeAnthropicError(err) {
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
