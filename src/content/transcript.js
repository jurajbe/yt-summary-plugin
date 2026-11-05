// Gets a video's transcript + metadata from YouTube, trying several routes
// because YouTube changes these internals regularly:
//   1. the "Show transcript" endpoint (youtubei/v1/get_transcript)
//   2. the caption track files (timedtext, json3)
//   3. opening the transcript panel in the page and reading it from the DOM

import { formatClock } from '../prompts.js';

const ORIGIN = 'https://www.youtube.com';

export class TranscriptError extends Error {}

/**
 * @returns {Promise<{videoId, title, channel, description, durationSeconds,
 *   transcript: string, captionLabel: string, source: string}>}
 */
export async function fetchVideo(videoId, { log = () => {} } = {}) {
  const page = await fetchWatchPage(videoId).catch((err) => {
    log('watch page fetch failed', err);
    return null;
  });

  const details = page?.playerResponse?.videoDetails || {};
  const meta = {
    videoId,
    title: details.title || document.title.replace(/ - YouTube$/, ''),
    channel: details.author || '',
    description: details.shortDescription || '',
    durationSeconds: Number(details.lengthSeconds) || 0,
  };

  const attempts = [
    ['transcript panel API', () => viaTranscriptApi(videoId, page)],
    ['caption track', () => viaCaptionTrack(page)],
    ['transcript panel DOM', () => viaTranscriptDom()],
  ];

  for (const [name, attempt] of attempts) {
    try {
      const result = await attempt();
      if (result?.segments?.length) {
        log(`transcript via ${name}: ${result.segments.length} segments`);
        return {
          ...meta,
          transcript: segmentsToText(result.segments),
          captionLabel: result.label || '',
          source: name,
        };
      }
      log(`transcript via ${name}: nothing`);
    } catch (err) {
      log(`transcript via ${name} failed`, err);
    }
  }

  const tracks = page?.playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  throw new TranscriptError(
    tracks?.length === 0 || (page && !tracks)
      ? "This video has no captions or transcript, so there's nothing to summarize."
      : "Couldn't load this video's transcript. Try reloading the page; if it keeps failing, open the video's transcript (… → Show transcript) once and try again.",
  );
}

// ---------------------------------------------------------------- watch page

async function fetchWatchPage(videoId) {
  const res = await fetch(`${ORIGIN}/watch?v=${encodeURIComponent(videoId)}&hl=en`, { credentials: 'include' });
  if (!res.ok) throw new Error(`watch page HTTP ${res.status}`);
  return parseWatchPage(await res.text());
}

export function parseWatchPage(html) {
  return {
    playerResponse: extractAssignedJson(html, 'ytInitialPlayerResponse'),
    initialData: extractAssignedJson(html, 'ytInitialData'),
    apiKey: html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)?.[1] || null,
    clientVersion: html.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/)?.[1] || null,
    visitorData: html.match(/"VISITOR_DATA"\s*:\s*"([^"]+)"/)?.[1] || null,
  };
}

/** Finds `name = {...};` in a page and parses the object with brace matching. */
export function extractAssignedJson(html, name) {
  // Matches `var name = {`, `window.name = {` and `window["name"] = {`.
  const re = new RegExp(`(?:\\b${name}|\\["${name}"\\])\\s*=\\s*\\{`, 'g');
  let match;
  while ((match = re.exec(html))) {
    const start = match.index + match[0].length - 1;
    const end = matchBrace(html, start);
    if (end === -1) continue;
    try {
      return JSON.parse(html.slice(start, end + 1));
    } catch {
      // keep looking
    }
  }
  return null;
}

function matchBrace(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

// ------------------------------------------------- 1. get_transcript (innertube)

async function viaTranscriptApi(videoId, page) {
  const params = findTranscriptParams(page?.initialData) || buildTranscriptParams(videoId);
  const body = {
    context: {
      client: {
        clientName: 'WEB',
        clientVersion: page?.clientVersion || '2.20260101.00.00',
        hl: 'en',
        ...(page?.visitorData ? { visitorData: page.visitorData } : {}),
      },
    },
    params,
  };
  const url = `${ORIGIN}/youtubei/v1/get_transcript?prettyPrint=false${page?.apiKey ? `&key=${page.apiKey}` : ''}`;

  let lastErr;
  // Try with the user's cookies first, then anonymously.
  for (const credentials of ['same-origin', 'omit']) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        credentials,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`get_transcript HTTP ${res.status}`);
      const segments = parseTranscriptApiResponse(await res.json());
      if (segments.length) return { segments, label: 'YouTube transcript' };
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

export function findTranscriptParams(initialData) {
  if (!initialData) return null;
  let found = null;
  walk(initialData, (node) => {
    if (!found && node.getTranscriptEndpoint?.params) found = node.getTranscriptEndpoint.params;
  });
  return found;
}

/** Fallback params when the page didn't include them: protobuf {1: videoId}. */
export function buildTranscriptParams(videoId) {
  const id = new TextEncoder().encode(videoId);
  return btoa(String.fromCharCode(0x0a, id.length, ...id));
}

export function parseTranscriptApiResponse(json) {
  const segments = [];
  walk(json, (node) => {
    const seg = node.transcriptSegmentRenderer;
    if (!seg) return;
    const text = runsText(seg.snippet);
    const start = Number(seg.startMs);
    if (text && Number.isFinite(start)) segments.push({ start: start / 1000, text });
  });
  return segments.sort((a, b) => a.start - b.start);
}

function runsText(snippet) {
  if (!snippet) return '';
  if (typeof snippet.simpleText === 'string') return snippet.simpleText;
  if (Array.isArray(snippet.runs)) return snippet.runs.map((r) => r.text || '').join('');
  if (typeof snippet.content === 'string') return snippet.content;
  return '';
}

// ------------------------------------------------- 2. caption tracks (timedtext)

async function viaCaptionTrack(page) {
  const tracks = page?.playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks?.length) return null;
  const track = pickTrack(tracks);
  const label = trackLabel(track);

  const urls = [withParam(track.baseUrl, 'fmt', 'json3')];
  // Newer players attach a proof-of-origin token to caption requests. If the
  // player already fetched captions for this video, reuse its token.
  const pot = findPlayerPoToken(track.baseUrl);
  if (pot) urls.unshift(withParam(withParam(urls[0], 'pot', pot.pot), 'c', pot.c || 'WEB'));

  for (const url of urls) {
    const absolute = new URL(url, ORIGIN).toString();
    const res = await fetch(absolute, { credentials: 'include' });
    if (!res.ok) continue;
    const body = await res.text();
    if (!body.trim()) continue; // YouTube returns 200 + empty body when it wants a token
    const segments = body.trimStart().startsWith('{') ? parseJson3(JSON.parse(body)) : parseTimedTextXml(body);
    if (segments.length) return { segments, label };
  }
  return null;
}

/** Prefer human captions in the spoken language, then auto-generated, then English. */
export function pickTrack(tracks) {
  const asr = tracks.find((t) => t.kind === 'asr');
  const manual = tracks.filter((t) => t.kind !== 'asr');
  const spoken = asr?.languageCode;
  return (
    (spoken && manual.find((t) => t.languageCode === spoken)) ||
    asr ||
    manual.find((t) => t.languageCode?.startsWith('en')) ||
    manual[0] ||
    tracks[0]
  );
}

function trackLabel(track) {
  const name = track.name?.simpleText || track.name?.runs?.map((r) => r.text).join('') || track.languageCode;
  return track.kind === 'asr' ? `${name} (auto-generated captions)` : `${name} captions`;
}

function findPlayerPoToken(baseUrl) {
  try {
    const wantedV = new URL(baseUrl, ORIGIN).searchParams.get('v');
    const entries = performance.getEntriesByType('resource');
    for (let i = entries.length - 1; i >= 0; i--) {
      const name = entries[i].name;
      if (!name.includes('/api/timedtext')) continue;
      const u = new URL(name);
      if (u.searchParams.get('v') === wantedV && u.searchParams.get('pot')) {
        return { pot: u.searchParams.get('pot'), c: u.searchParams.get('c') };
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function withParam(url, key, value) {
  const u = new URL(url, ORIGIN);
  u.searchParams.set(key, value);
  return u.toString();
}

export function parseJson3(json) {
  const segments = [];
  for (const ev of json.events || []) {
    if (!ev.segs) continue;
    const text = ev.segs.map((s) => s.utf8 || '').join('');
    if (!text.trim()) continue;
    segments.push({ start: (ev.tStartMs || 0) / 1000, text });
  }
  return segments;
}

export function parseTimedTextXml(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const segments = [];
  // Format 1: <text start="1.2" dur="..">..</text>; format 3: <p t="1200" d="..">..</p>
  for (const el of doc.querySelectorAll('text[start]')) {
    segments.push({ start: Number(el.getAttribute('start')), text: decodeEntities(el.textContent) });
  }
  if (!segments.length) {
    for (const el of doc.querySelectorAll('p[t]')) {
      segments.push({ start: Number(el.getAttribute('t')) / 1000, text: decodeEntities(el.textContent) });
    }
  }
  return segments.filter((s) => s.text.trim());
}

function decodeEntities(s) {
  // Caption XML is often double-escaped (&amp;#39;), so decode one more level.
  return s.replace(/&(#\d+|#x[\da-f]+|amp|lt|gt|quot|apos|#39);/gi, (m) => {
    const map = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" };
    if (map[m.toLowerCase()]) return map[m.toLowerCase()];
    const code = m[2] === 'x' || m[2] === 'X' ? parseInt(m.slice(3, -1), 16) : parseInt(m.slice(2, -1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

// ------------------------------------------------- 3. transcript panel in the DOM

const SEGMENT_SELECTOR = 'ytd-transcript-segment-renderer, transcript-segment-view-model';
const PANEL_SELECTOR =
  'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]';

async function viaTranscriptDom() {
  let segments = readTranscriptDom();
  if (segments.length) return { segments, label: 'YouTube transcript' };

  const button = findShowTranscriptButton();
  if (!button) return null;
  const panel = document.querySelector(PANEL_SELECTOR);
  const wasVisible = panel?.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED';
  button.click();

  segments = await waitFor(() => {
    const s = readTranscriptDom();
    return s.length ? s : null;
  }, 10000);

  // Put the page back how we found it.
  if (!wasVisible) {
    const p = document.querySelector(PANEL_SELECTOR);
    const close = p?.querySelector('#visibility-button button, button[aria-label="Close transcript"]');
    if (close) close.click();
    else p?.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
  }
  return segments?.length ? { segments, label: 'YouTube transcript' } : null;
}

function findShowTranscriptButton() {
  return (
    document.querySelector('ytd-video-description-transcript-section-renderer button') ||
    [...document.querySelectorAll('button, tp-yt-paper-button, ytd-button-renderer')].find((b) =>
      /transcript/i.test(b.getAttribute('aria-label') || b.textContent || ''),
    )
  );
}

export function readTranscriptDom(root = document) {
  const segments = [];
  for (const el of root.querySelectorAll(SEGMENT_SELECTOR)) {
    const lines = (el.innerText || el.textContent || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const tsIndex = lines.findIndex((l) => /^\d{1,2}(:\d{2}){1,2}$/.test(l));
    if (tsIndex === -1) continue;
    const text = lines.filter((_, i) => i !== tsIndex).join(' ');
    if (text) segments.push({ start: parseClock(lines[tsIndex]), text });
  }
  return segments;
}

function waitFor(fn, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const tick = () => {
      const v = fn();
      if (v || Date.now() - startedAt > timeoutMs) resolve(v);
      else setTimeout(tick, 250);
    };
    tick();
  });
}

// ------------------------------------------------- shared

export function parseClock(s) {
  return s.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
}

/**
 * Merge caption fragments into ~20 second lines prefixed with [m:ss]. Fewer,
 * longer lines keep the token count down while still giving precise timestamps.
 */
export function segmentsToText(segments, windowSeconds = 20) {
  const lines = [];
  let current = null;
  for (const seg of segments) {
    const text = seg.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (!current || seg.start - current.start >= windowSeconds) {
      if (current) lines.push(current);
      current = { start: seg.start, parts: [text] };
    } else {
      current.parts.push(text);
    }
  }
  if (current) lines.push(current);
  return lines.map((l) => `[${formatClock(l.start)}] ${l.parts.join(' ')}`).join('\n');
}

function walk(node, visit) {
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== 'object') continue;
    visit(n);
    for (const v of Array.isArray(n) ? n : Object.values(n)) {
      if (v && typeof v === 'object') stack.push(v);
    }
  }
}
