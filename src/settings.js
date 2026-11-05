export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 — best quality (default)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — faster, cheaper' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — fastest, cheapest' },
];

export const EFFORTS = [
  { id: 'low', label: 'Low — fastest answers (default)' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High — most thorough, slowest' },
];

export const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'claude-opus-5-5',
  effort: 'low',
  language: 'English',
  autoSummarize: false,
};

export async function loadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS).concat('apiBaseUrl'));
  return { ...DEFAULT_SETTINGS, ...stored };
}

/** Same as loadSettings but never exposes the API key (for content scripts). */
export async function loadPublicSettings() {
  const { apiKey, apiBaseUrl, ...rest } = await loadSettings();
  return { ...rest, hasApiKey: Boolean(apiKey) };
}
