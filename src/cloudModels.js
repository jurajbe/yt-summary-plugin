// Ollama Cloud's model catalog, cached in storage and refreshed once a day
// (chrome.alarms), or on demand from the settings page.

import { listModels, ollamaConnection } from './providers/ollama.js';
import { loadSettings } from './settings.js';

export const REFRESH_ALARM = 'refresh-cloud-models';
const DAY_MS = 24 * 60 * 60 * 1000;

export async function getCachedCloudModels() {
  const { cloudModels = [], cloudModelsFetchedAt = 0 } = await chrome.storage.local.get(['cloudModels', 'cloudModelsFetchedAt']);
  return { models: cloudModels, fetchedAt: cloudModelsFetchedAt };
}

/** Returns the catalog; fetches a fresh copy when forced or older than a day. */
export async function refreshCloudModels({ force = false, apiKey } = {}) {
  const cached = await getCachedCloudModels();
  if (!force && cached.models.length && Date.now() - cached.fetchedAt < DAY_MS) return cached;
  const settings = await loadSettings();
  const models = await listModels(ollamaConnection({ ...settings, ...(apiKey ? { ollamaApiKey: apiKey } : {}), ollamaMode: 'cloud' }));
  const fetchedAt = Date.now();
  await chrome.storage.local.set({ cloudModels: models, cloudModelsFetchedAt: fetchedAt });
  return { models, fetchedAt };
}

/** Make sure the daily alarm exists (creating it again would reset its timer). */
export async function ensureRefreshAlarm() {
  if (!chrome.alarms) return;
  const existing = await chrome.alarms.get(REFRESH_ALARM);
  if (!existing) chrome.alarms.create(REFRESH_ALARM, { delayInMinutes: 1, periodInMinutes: 24 * 60 });
}
