export const PROVIDERS = [
  { id: 'ollama', label: 'Ollama (cloud or local)' },
  { id: 'anthropic', label: 'Claude (Anthropic API key)' },
];

export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — best quality (default)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — faster, cheaper' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — fastest, cheapest' },
];

export const EFFORTS = [
  { id: 'low', label: 'Low — fastest answers (default)' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High — most thorough, slowest' },
];

export const CONTEXT_SIZES = [
  { id: 8192, label: '8k — short videos only (least memory)' },
  { id: 16384, label: '16k — up to ~25 min videos' },
  { id: 32768, label: '32k — up to ~1 hour (default)' },
  { id: 65536, label: '64k — up to ~2 hours' },
  { id: 131072, label: '128k — long podcasts (lots of memory)' },
];

/**
 * Suggested local models, smallest first. Any chat model installed in Ollama
 * works; these follow instructions well and have long context windows.
 */
export const SUGGESTED_OLLAMA_MODELS = [
  { name: 'gemma3:4b', size: '3.3 GB', ram: '8 GB RAM', note: 'Fast; fine for short videos, misses detail on long ones.' },
  { name: 'llama3.1:8b', size: '4.9 GB', ram: '8–16 GB RAM', note: 'Reliable all-rounder, 128k context.' },
  { name: 'qwen3:8b', size: '5.2 GB', ram: '16 GB RAM', note: 'Strong for its size. Reasoning model: effort Low turns thinking off for speed.' },
  { name: 'gemma3:12b', size: '8.1 GB', ram: '16 GB RAM', note: 'Best quality-per-GB for summaries. Recommended start.' },
  { name: 'qwen3:14b', size: '9.3 GB', ram: '16–24 GB RAM', note: 'Very good summaries and follow-up answers.' },
  { name: 'gpt-oss:20b', size: '14 GB', ram: '24 GB RAM / 16 GB VRAM', note: 'OpenAI open-weight reasoning model; great on tricky follow-ups.' },
  { name: 'qwen3:30b', size: '19 GB', ram: '32 GB RAM', note: 'Mixture-of-experts: big-model quality at small-model speed.' },
  { name: 'gemma3:27b', size: '17 GB', ram: '32 GB RAM / 24 GB VRAM', note: 'Best local quality in this list.' },
];

export const DEFAULT_SETTINGS = {
  provider: 'ollama',
  // Claude
  apiKey: '',
  model: 'claude-opus-5-5',
  effort: 'low',
  // Ollama
  ollamaMode: 'cloud', // 'cloud' (ollama.com, API key) or 'local' (your own Ollama server)
  ollamaApiKey: '',
  ollamaCloudModel: '', // empty = best available cloud model
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: '',
  ollamaMaxContext: 32768,
  // Both
  language: 'English',
  autoSummarize: false,
};

export async function loadSettings() {
  // apiBaseUrl / ollamaCloudBaseUrl are test-only overrides with no UI.
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS).concat('apiBaseUrl', 'ollamaCloudBaseUrl'));
  return { ...DEFAULT_SETTINGS, ...stored };
}

export function isConfigured(s) {
  if (s.provider !== 'ollama') return Boolean(s.apiKey);
  return s.ollamaMode === 'local' ? Boolean(s.ollamaModel) : Boolean(s.ollamaApiKey);
}

/** What content scripts may know: never the API key. */
export async function loadPublicSettings() {
  const s = await loadSettings();
  return {
    provider: s.provider,
    ollamaMode: s.ollamaMode,
    configured: isConfigured(s),
    autoSummarize: s.autoSummarize,
    modelName: s.provider !== 'ollama' ? s.model : s.ollamaMode === 'local' ? s.ollamaModel : s.ollamaCloudModel,
  };
}
