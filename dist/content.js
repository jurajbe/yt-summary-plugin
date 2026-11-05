(() => {
  // src/prompts.js
  function formatClock(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor(s % 3600 / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  }

  // src/content/transcript.js
  var ORIGIN = "https://www.youtube.com";
  var TranscriptError = class extends Error {
  };
  async function fetchVideo(videoId, { log: log2 = () => {
  } } = {}) {
    const page = await fetchWatchPage(videoId).catch((err) => {
      log2("watch page fetch failed", err);
      return null;
    });
    const details = page?.playerResponse?.videoDetails || {};
    const meta = {
      videoId,
      title: details.title || document.title.replace(/ - YouTube$/, ""),
      channel: details.author || "",
      description: details.shortDescription || "",
      durationSeconds: Number(details.lengthSeconds) || 0
    };
    const attempts = [
      ["transcript panel API", () => viaTranscriptApi(videoId, page)],
      ["caption track", () => viaCaptionTrack(page)],
      ["transcript panel DOM", () => viaTranscriptDom()]
    ];
    for (const [name, attempt] of attempts) {
      try {
        const result = await attempt();
        if (result?.segments?.length) {
          log2(`transcript via ${name}: ${result.segments.length} segments`);
          return {
            ...meta,
            transcript: segmentsToText(result.segments),
            captionLabel: result.label || "",
            source: name
          };
        }
        log2(`transcript via ${name}: nothing`);
      } catch (err) {
        log2(`transcript via ${name} failed`, err);
      }
    }
    const tracks = page?.playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    throw new TranscriptError(
      tracks?.length === 0 || page && !tracks ? "This video has no captions or transcript, so there's nothing to summarize." : "Couldn't load this video's transcript. Try reloading the page; if it keeps failing, open the video's transcript (\u2026 \u2192 Show transcript) once and try again."
    );
  }
  async function fetchWatchPage(videoId) {
    const res = await fetch(`${ORIGIN}/watch?v=${encodeURIComponent(videoId)}&hl=en`, { credentials: "include" });
    if (!res.ok) throw new Error(`watch page HTTP ${res.status}`);
    return parseWatchPage(await res.text());
  }
  function parseWatchPage(html) {
    return {
      playerResponse: extractAssignedJson(html, "ytInitialPlayerResponse"),
      initialData: extractAssignedJson(html, "ytInitialData"),
      apiKey: html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)?.[1] || null,
      clientVersion: html.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/)?.[1] || null,
      visitorData: html.match(/"VISITOR_DATA"\s*:\s*"([^"]+)"/)?.[1] || null
    };
  }
  function extractAssignedJson(html, name) {
    const re = new RegExp(`(?:\\b${name}|\\["${name}"\\])\\s*=\\s*\\{`, "g");
    let match;
    while (match = re.exec(html)) {
      const start = match.index + match[0].length - 1;
      const end = matchBrace(html, start);
      if (end === -1) continue;
      try {
        return JSON.parse(html.slice(start, end + 1));
      } catch {
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
        if (c === "\\") i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return i;
    }
    return -1;
  }
  async function viaTranscriptApi(videoId, page) {
    const params = findTranscriptParams(page?.initialData) || buildTranscriptParams(videoId);
    const body = {
      context: {
        client: {
          clientName: "WEB",
          clientVersion: page?.clientVersion || "2.20260101.00.00",
          hl: "en",
          ...page?.visitorData ? { visitorData: page.visitorData } : {}
        }
      },
      params
    };
    const url = `${ORIGIN}/youtubei/v1/get_transcript?prettyPrint=false${page?.apiKey ? `&key=${page.apiKey}` : ""}`;
    let lastErr;
    for (const credentials of ["same-origin", "omit"]) {
      try {
        const res = await fetch(url, {
          method: "POST",
          credentials,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error(`get_transcript HTTP ${res.status}`);
        const segments = parseTranscriptApiResponse(await res.json());
        if (segments.length) return { segments, label: "YouTube transcript" };
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) throw lastErr;
    return null;
  }
  function findTranscriptParams(initialData) {
    if (!initialData) return null;
    let found = null;
    walk(initialData, (node) => {
      if (!found && node.getTranscriptEndpoint?.params) found = node.getTranscriptEndpoint.params;
    });
    return found;
  }
  function buildTranscriptParams(videoId) {
    const id = new TextEncoder().encode(videoId);
    return btoa(String.fromCharCode(10, id.length, ...id));
  }
  function parseTranscriptApiResponse(json) {
    const segments = [];
    walk(json, (node) => {
      const seg = node.transcriptSegmentRenderer;
      if (!seg) return;
      const text = runsText(seg.snippet);
      const start = Number(seg.startMs);
      if (text && Number.isFinite(start)) segments.push({ start: start / 1e3, text });
    });
    return segments.sort((a, b) => a.start - b.start);
  }
  function runsText(snippet) {
    if (!snippet) return "";
    if (typeof snippet.simpleText === "string") return snippet.simpleText;
    if (Array.isArray(snippet.runs)) return snippet.runs.map((r) => r.text || "").join("");
    if (typeof snippet.content === "string") return snippet.content;
    return "";
  }
  async function viaCaptionTrack(page) {
    const tracks = page?.playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks?.length) return null;
    const track = pickTrack(tracks);
    const label = trackLabel(track);
    const urls = [withParam(track.baseUrl, "fmt", "json3")];
    const pot = findPlayerPoToken(track.baseUrl);
    if (pot) urls.unshift(withParam(withParam(urls[0], "pot", pot.pot), "c", pot.c || "WEB"));
    for (const url of urls) {
      const absolute = new URL(url, ORIGIN).toString();
      const res = await fetch(absolute, { credentials: "include" });
      if (!res.ok) continue;
      const body = await res.text();
      if (!body.trim()) continue;
      const segments = body.trimStart().startsWith("{") ? parseJson3(JSON.parse(body)) : parseTimedTextXml(body);
      if (segments.length) return { segments, label };
    }
    return null;
  }
  function pickTrack(tracks) {
    const asr = tracks.find((t) => t.kind === "asr");
    const manual = tracks.filter((t) => t.kind !== "asr");
    const spoken = asr?.languageCode;
    return spoken && manual.find((t) => t.languageCode === spoken) || asr || manual.find((t) => t.languageCode?.startsWith("en")) || manual[0] || tracks[0];
  }
  function trackLabel(track) {
    const name = track.name?.simpleText || track.name?.runs?.map((r) => r.text).join("") || track.languageCode;
    return track.kind === "asr" ? `${name} (auto-generated captions)` : `${name} captions`;
  }
  function findPlayerPoToken(baseUrl) {
    try {
      const wantedV = new URL(baseUrl, ORIGIN).searchParams.get("v");
      const entries = performance.getEntriesByType("resource");
      for (let i = entries.length - 1; i >= 0; i--) {
        const name = entries[i].name;
        if (!name.includes("/api/timedtext")) continue;
        const u = new URL(name);
        if (u.searchParams.get("v") === wantedV && u.searchParams.get("pot")) {
          return { pot: u.searchParams.get("pot"), c: u.searchParams.get("c") };
        }
      }
    } catch {
    }
    return null;
  }
  function withParam(url, key, value) {
    const u = new URL(url, ORIGIN);
    u.searchParams.set(key, value);
    return u.toString();
  }
  function parseJson3(json) {
    const segments = [];
    for (const ev of json.events || []) {
      if (!ev.segs) continue;
      const text = ev.segs.map((s) => s.utf8 || "").join("");
      if (!text.trim()) continue;
      segments.push({ start: (ev.tStartMs || 0) / 1e3, text });
    }
    return segments;
  }
  function parseTimedTextXml(xml) {
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const segments = [];
    for (const el of doc.querySelectorAll("text[start]")) {
      segments.push({ start: Number(el.getAttribute("start")), text: decodeEntities(el.textContent) });
    }
    if (!segments.length) {
      for (const el of doc.querySelectorAll("p[t]")) {
        segments.push({ start: Number(el.getAttribute("t")) / 1e3, text: decodeEntities(el.textContent) });
      }
    }
    return segments.filter((s) => s.text.trim());
  }
  function decodeEntities(s) {
    return s.replace(/&(#\d+|#x[\da-f]+|amp|lt|gt|quot|apos|#39);/gi, (m) => {
      const map = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'" };
      if (map[m.toLowerCase()]) return map[m.toLowerCase()];
      const code = m[2] === "x" || m[2] === "X" ? parseInt(m.slice(3, -1), 16) : parseInt(m.slice(2, -1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    });
  }
  var SEGMENT_SELECTOR = "ytd-transcript-segment-renderer, transcript-segment-view-model";
  var PANEL_SELECTOR = 'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]';
  async function viaTranscriptDom() {
    let segments = readTranscriptDom();
    if (segments.length) return { segments, label: "YouTube transcript" };
    const button = findShowTranscriptButton();
    if (!button) return null;
    const panel2 = document.querySelector(PANEL_SELECTOR);
    const wasVisible = panel2?.getAttribute("visibility") === "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED";
    button.click();
    segments = await waitFor(() => {
      const s = readTranscriptDom();
      return s.length ? s : null;
    }, 1e4);
    if (!wasVisible) {
      const p = document.querySelector(PANEL_SELECTOR);
      const close = p?.querySelector('#visibility-button button, button[aria-label="Close transcript"]');
      if (close) close.click();
      else p?.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
    }
    return segments?.length ? { segments, label: "YouTube transcript" } : null;
  }
  function findShowTranscriptButton() {
    return document.querySelector("ytd-video-description-transcript-section-renderer button") || [...document.querySelectorAll("button, tp-yt-paper-button, ytd-button-renderer")].find(
      (b) => /transcript/i.test(b.getAttribute("aria-label") || b.textContent || "")
    );
  }
  function readTranscriptDom(root = document) {
    const segments = [];
    for (const el of root.querySelectorAll(SEGMENT_SELECTOR)) {
      const lines = (el.innerText || el.textContent || "").split("\n").map((l) => l.trim()).filter(Boolean);
      const tsIndex = lines.findIndex((l) => /^\d{1,2}(:\d{2}){1,2}$/.test(l));
      if (tsIndex === -1) continue;
      const text = lines.filter((_, i) => i !== tsIndex).join(" ");
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
  function parseClock(s) {
    return s.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
  }
  function segmentsToText(segments, windowSeconds = 20) {
    const lines = [];
    let current = null;
    for (const seg of segments) {
      const text = seg.text.replace(/\s+/g, " ").trim();
      if (!text) continue;
      if (!current || seg.start - current.start >= windowSeconds) {
        if (current) lines.push(current);
        current = { start: seg.start, parts: [text] };
      } else {
        current.parts.push(text);
      }
    }
    if (current) lines.push(current);
    return lines.map((l) => `[${formatClock(l.start)}] ${l.parts.join(" ")}`).join("\n");
  }
  function walk(node, visit) {
    const stack = [node];
    while (stack.length) {
      const n = stack.pop();
      if (!n || typeof n !== "object") continue;
      visit(n);
      for (const v of Array.isArray(n) ? n : Object.values(n)) {
        if (v && typeof v === "object") stack.push(v);
      }
    }
  }

  // src/content/markdown.js
  var TIME_RE = /\b(\d{1,2}:\d{2}(?::\d{2})?)\b/g;
  function renderMarkdown(md, { onSeek } = {}) {
    const frag = document.createDocumentFragment();
    const lines = md.replace(/\r\n?/g, "\n").split("\n");
    let list = null;
    let para = null;
    const closeBlocks = () => {
      list = null;
      para = null;
    };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      if (!line.trim()) {
        closeBlocks();
        continue;
      }
      if (/^\s*(```|~~~)/.test(line)) continue;
      const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
      if (heading) {
        closeBlocks();
        const level = Math.min(6, heading[1].length + 2);
        const h = document.createElement(`h${Math.max(3, level)}`);
        appendInline(h, heading[2].replace(/\s*#+\s*$/, ""), onSeek);
        frag.appendChild(h);
        continue;
      }
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        closeBlocks();
        frag.appendChild(document.createElement("hr"));
        continue;
      }
      const bullet = line.match(/^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/);
      if (bullet) {
        para = null;
        const indent = bullet[1].replace(/\t/g, "  ").length;
        const ordered = /\d/.test(bullet[2]);
        if (!list || list.ordered !== ordered || indent >= 2 !== list.indent >= 2) {
          const el = document.createElement(ordered ? "ol" : "ul");
          if (indent >= 2) el.className = "nested";
          frag.appendChild(el);
          list = { el, ordered, indent };
        }
        const li = document.createElement("li");
        appendInline(li, bullet[3], onSeek);
        list.el.appendChild(li);
        continue;
      }
      if (list && /^\s{2,}\S/.test(raw) && list.el.lastElementChild) {
        list.el.lastElementChild.appendChild(document.createTextNode(" "));
        appendInline(list.el.lastElementChild, line.trim(), onSeek);
        continue;
      }
      list = null;
      if (!para) {
        para = document.createElement("p");
        frag.appendChild(para);
      } else {
        para.appendChild(document.createElement("br"));
      }
      appendInline(para, line.trim().replace(/^>\s?/, ""), onSeek);
    }
    return frag;
  }
  function appendInline(parent, text, onSeek) {
    const re = /(\*\*|__)(.+?)\1|`([^`]+)`|(?<![\w*])[*_](?![\s*_])(.+?)(?<![\s*_])[*_](?![\w*])|\[([^\]\n]*\d:\d{2}[^\]\n]*)\](?!\()|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
    let last = 0;
    let m;
    while (m = re.exec(text)) {
      if (m.index > last) appendTimes(parent, text.slice(last, m.index), onSeek, false);
      if (m[2] !== void 0) {
        const b = document.createElement("strong");
        appendInline(b, m[2], onSeek);
        parent.appendChild(b);
      } else if (m[3] !== void 0) {
        const c = document.createElement("code");
        c.textContent = m[3];
        parent.appendChild(c);
      } else if (m[4] !== void 0) {
        const i = document.createElement("em");
        appendInline(i, m[4], onSeek);
        parent.appendChild(i);
      } else if (m[5] !== void 0) {
        appendTimes(parent, m[5], onSeek, true);
      } else if (m[6] !== void 0) {
        appendInline(parent, m[6], onSeek);
      }
      last = re.lastIndex;
    }
    if (last < text.length) appendTimes(parent, text.slice(last), onSeek, false);
  }
  function appendTimes(parent, text, onSeek, linkify) {
    if (!linkify || !onSeek) {
      parent.appendChild(document.createTextNode(linkify ? `[${text}]` : text));
      return;
    }
    let last = 0;
    let m;
    TIME_RE.lastIndex = 0;
    while (m = TIME_RE.exec(text)) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      const btn = document.createElement("button");
      btn.className = "ts";
      btn.type = "button";
      btn.textContent = m[1];
      btn.title = `Jump to ${m[1]}`;
      const seconds = m[1].split(":").reduce((acc, p) => acc * 60 + Number(p), 0);
      btn.addEventListener("click", () => onSeek(seconds));
      parent.appendChild(btn);
      last = TIME_RE.lastIndex;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  // src/content/panel-css.js
  var PANEL_CSS = `
:host {
  all: initial;
  display: block;
  margin: 0 0 16px;
  --fg: var(--yt-spec-text-primary, #0f0f0f);
  --fg2: var(--yt-spec-text-secondary, #606060);
  --bg: var(--yt-spec-base-background, #fff);
  --bg2: var(--yt-spec-badge-chip-background, rgba(0,0,0,0.05));
  --bg3: var(--yt-spec-button-chip-background-hover, rgba(0,0,0,0.1));
  --line: var(--yt-spec-10-percent-layer, rgba(0,0,0,0.1));
  --accent: #d97757;
  --link: var(--yt-spec-call-to-action, #065fd4);
  --err: #cc0000;
  font-family: "Roboto", "Arial", sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: var(--fg);
}
* { box-sizing: border-box; }
button { font: inherit; color: inherit; cursor: pointer; }
[hidden] { display: none !important; }

.panel {
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--bg);
  overflow: hidden;
}
header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 8px 8px 14px;
  border-bottom: 1px solid var(--line);
}
.title { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 500; cursor: default; }
.logo {
  display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 6px;
  background: var(--accent); color: #fff; font-size: 13px;
}
.header-actions { display: flex; gap: 2px; }
.icon-btn {
  border: 0; background: transparent; width: 32px; height: 32px; border-radius: 50%;
  font-size: 16px; color: var(--fg2);
}
.icon-btn:hover { background: var(--bg2); color: var(--fg); }

.body { padding: 12px 14px 14px; }

.tabs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.tab {
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  padding: 8px 4px; border: 1px solid transparent; border-radius: 10px;
  background: var(--bg2); font-size: 13px; font-weight: 500; white-space: nowrap;
}
.tab:hover { background: var(--bg3); }
.tab.active { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
.tab-icon { font-size: 16px; line-height: 1; }
.tab.busy .tab-icon { animation: pulse 1s ease-in-out infinite; }
.tab.done:not(.active)::after { content: ""; width: 5px; height: 5px; border-radius: 50%; background: var(--accent); }

.output {
  margin-top: 12px; max-height: 60vh; overflow-y: auto; overscroll-behavior: contain;
  font-size: 14px;
}
.output:empty { display: none; }
.output > :first-child, .msg > :first-child { margin-top: 0; }
.output > :last-child, .msg > :last-child { margin-bottom: 0; }
p { margin: 0 0 10px; }
h3, h4, h5, h6 { margin: 14px 0 6px; font-size: 14px; font-weight: 700; }
h3 { font-size: 15px; }
ul, ol { margin: 0 0 10px; padding-left: 20px; }
ul.nested, ol.nested { padding-left: 38px; margin-top: -6px; }
li { margin: 3px 0; }
li::marker { color: var(--fg2); }
strong { font-weight: 700; }
code { font-family: "Roboto Mono", monospace; font-size: 12.5px; background: var(--bg2); padding: 1px 4px; border-radius: 4px; }
hr { border: 0; border-top: 1px solid var(--line); margin: 12px 0; }
.streaming::after { content: "\u258D"; color: var(--accent); animation: pulse 0.9s step-end infinite; }

.ts {
  border: 0; padding: 0 5px; margin: 0 1px; border-radius: 4px;
  background: color-mix(in srgb, var(--link) 12%, transparent);
  color: var(--link); font-weight: 500; font-size: 0.95em; font-variant-numeric: tabular-nums;
}
.ts:hover { background: color-mix(in srgb, var(--link) 22%, transparent); }

.placeholder { color: var(--fg2); font-size: 13px; }
.status { display: flex; align-items: center; gap: 8px; color: var(--fg2); font-size: 13px; }
.spinner {
  width: 12px; height: 12px; border-radius: 50%; flex: none;
  border: 2px solid var(--line); border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}
.error { color: var(--err); font-size: 13px; }
.notice { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }

.output-bar { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
.meta { flex: 1; color: var(--fg2); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.small-btn {
  border: 0; background: transparent; color: var(--fg2); font-size: 12px;
  padding: 3px 8px; border-radius: 12px;
}
.small-btn:hover { background: var(--bg2); color: var(--fg); }

.chat-log { display: flex; flex-direction: column; gap: 8px; margin-top: 14px; }
.chat-log:empty { display: none; }
.msg { padding: 8px 11px; border-radius: 12px; max-width: 100%; overflow-wrap: anywhere; }
.msg.user { align-self: flex-end; max-width: 85%; background: color-mix(in srgb, var(--accent) 16%, transparent); white-space: pre-wrap; }
.msg.assistant { align-self: stretch; background: var(--bg2); }

.chat-form {
  display: flex; align-items: flex-end; gap: 6px; margin-top: 12px;
  padding-top: 12px; border-top: 1px solid var(--line);
}
textarea {
  flex: 1; resize: none; min-height: 36px; max-height: 160px;
  padding: 8px 12px; border: 1px solid var(--line); border-radius: 18px;
  background: var(--bg); color: var(--fg); font: inherit; font-size: 14px; line-height: 1.4;
  outline: none;
}
textarea:focus { border-color: var(--accent); }
textarea:disabled { opacity: 0.5; }
.ask-btn {
  height: 36px; padding: 0 16px; border: 0; border-radius: 18px;
  background: var(--accent); color: #fff; font-weight: 500;
}
.ask-btn:hover { filter: brightness(1.08); }
.ask-btn:disabled { opacity: 0.5; cursor: default; }
.clear-chat { margin-top: 6px; }

@keyframes spin { to { transform: rotate(360deg); } }
@keyframes pulse { 50% { opacity: 0.35; } }
`;

  // src/content/panel.js
  var MODE_TABS = [
    { id: "tldr", icon: "\u26A1", label: "The point", hint: "Just tell me the trick" },
    { id: "key", icon: "\u{1F4CB}", label: "Key points", hint: "Bullet takeaways with timestamps" },
    { id: "deep", icon: "\u{1F4D6}", label: "Deep dive", hint: "Section-by-section breakdown" }
  ];
  var log = (...args) => console.debug("[yt-summary]", ...args);
  var Panel = class {
    constructor() {
      this.host = document.createElement("div");
      this.host.id = "yt-summary-claude";
      const root = this.host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = PANEL_CSS;
      root.appendChild(style);
      this.root = root;
      this.cache = /* @__PURE__ */ new Map();
      this.state = null;
      this.settings = null;
      this.collapsed = false;
      this.renderQueued = false;
      this.build();
    }
    // ------------------------------------------------------------ lifecycle
    async setVideo(videoId) {
      if (this.state?.videoId === videoId) return;
      if (this.state) this.abortAll(this.state);
      if (!videoId) {
        this.state = null;
        this.host.remove();
        return;
      }
      let state = this.cache.get(videoId);
      if (!state) {
        state = newState(videoId);
        this.cache.set(videoId, state);
        if (this.cache.size > 15) this.cache.delete(this.cache.keys().next().value);
      }
      this.state = state;
      this.chatInput.value = "";
      this.render();
      this.settings = await getSettings();
      this.render();
      if (this.settings?.autoSummarize && this.settings.hasApiKey && !state.outputs.tldr.text && this.state === state) {
        this.runMode("tldr");
      }
    }
    /** Put the panel at the top of the sidebar, or under the title on narrow layouts. */
    mount() {
      const flexy = document.querySelector("ytd-watch-flexy");
      if (!flexy) return;
      const secondary = flexy.querySelector("#secondary-inner") || flexy.querySelector("#secondary");
      const below = flexy.querySelector("#below");
      const useSidebar = secondary && secondary.getClientRects().length > 0 && secondary.offsetWidth > 200;
      if (useSidebar) {
        if (this.host.parentElement !== secondary || secondary.firstElementChild !== this.host) secondary.prepend(this.host);
      } else if (below) {
        const anchor = below.querySelector(":scope > ytd-watch-metadata");
        if (this.host.parentElement !== below) {
          if (anchor) anchor.after(this.host);
          else below.prepend(this.host);
        }
      }
    }
    shortcut() {
      if (!this.state) return;
      this.setCollapsed(false);
      this.host.scrollIntoView({ behavior: "smooth", block: "nearest" });
      if (!this.state.outputs.tldr.text && !this.state.outputs.tldr.busy) this.runMode("tldr");
      else this.selectMode("tldr");
    }
    // ------------------------------------------------------------ DOM
    build() {
      const el = (tag, cls, text) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
      };
      const panel2 = el("section", "panel");
      const header = el("header");
      const title = el("div", "title");
      title.append(el("span", "logo", "\u26A1"), el("span", null, "Skip the video"));
      const headerActions = el("div", "header-actions");
      const settingsBtn = el("button", "icon-btn", "\u2699");
      settingsBtn.title = "Settings (API key, model, language)";
      settingsBtn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "openOptions" }));
      this.collapseBtn = el("button", "icon-btn", "\u25BE");
      this.collapseBtn.title = "Collapse";
      this.collapseBtn.addEventListener("click", () => this.setCollapsed(!this.collapsed));
      headerActions.append(settingsBtn, this.collapseBtn);
      header.append(title, headerActions);
      title.addEventListener("click", () => this.collapsed && this.setCollapsed(false));
      this.body = el("div", "body");
      this.tabs = el("div", "tabs");
      this.tabButtons = {};
      for (const t of MODE_TABS) {
        const b = el("button", "tab");
        b.append(el("span", "tab-icon", t.icon), el("span", null, t.label));
        b.title = t.hint;
        b.addEventListener("click", () => this.onTab(t.id));
        this.tabButtons[t.id] = b;
        this.tabs.appendChild(b);
      }
      this.output = el("div", "output");
      this.outputBar = el("div", "output-bar");
      this.meta = el("span", "meta");
      this.copyBtn = el("button", "small-btn", "Copy");
      this.copyBtn.addEventListener("click", () => this.copyActive());
      this.redoBtn = el("button", "small-btn", "\u21BB Redo");
      this.redoBtn.title = "Generate this summary again";
      this.redoBtn.addEventListener("click", () => this.state && this.runMode(this.state.activeMode, { force: true }));
      this.outputBar.append(this.meta, this.copyBtn, this.redoBtn);
      this.chatLog = el("div", "chat-log");
      const form = el("form", "chat-form");
      this.chatInput = el("textarea");
      this.chatInput.rows = 1;
      this.chatInput.placeholder = "Ask anything about this video\u2026";
      for (const type of ["keydown", "keyup", "keypress"]) {
        this.chatInput.addEventListener(type, (e) => {
          e.stopPropagation();
          if (type === "keydown" && e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            form.requestSubmit();
          }
        });
      }
      this.chatInput.addEventListener("input", () => autosize(this.chatInput));
      this.askBtn = el("button", "ask-btn", "Ask");
      this.askBtn.type = "submit";
      form.append(this.chatInput, this.askBtn);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        this.ask(this.chatInput.value);
      });
      this.clearChatBtn = el("button", "small-btn clear-chat", "Clear chat");
      this.clearChatBtn.type = "button";
      this.clearChatBtn.addEventListener("click", () => this.clearChat());
      this.body.append(this.tabs, this.output, this.outputBar, this.chatLog, form, this.clearChatBtn);
      panel2.append(header, this.body);
      this.root.appendChild(panel2);
    }
    setCollapsed(collapsed) {
      this.collapsed = collapsed;
      this.body.hidden = collapsed;
      this.collapseBtn.textContent = collapsed ? "\u25B8" : "\u25BE";
      this.collapseBtn.title = collapsed ? "Expand" : "Collapse";
    }
    queueRender() {
      if (this.renderQueued) return;
      this.renderQueued = true;
      requestAnimationFrame(() => {
        this.renderQueued = false;
        this.render();
      });
    }
    render() {
      const s = this.state;
      if (!s) return;
      const onSeek = seek;
      for (const t of MODE_TABS) {
        const b = this.tabButtons[t.id];
        b.classList.toggle("active", s.activeMode === t.id);
        b.classList.toggle("busy", s.outputs[t.id].busy);
        b.classList.toggle("done", Boolean(s.outputs[t.id].text) && !s.outputs[t.id].busy);
      }
      this.output.replaceChildren();
      const out = s.activeMode ? s.outputs[s.activeMode] : null;
      if (this.settings && !this.settings.hasApiKey) {
        this.output.append(noKeyNotice());
      } else if (!out) {
        const p = document.createElement("p");
        p.className = "placeholder";
        p.textContent = "Pick one: \u26A1 the payoff in 3 sentences, \u{1F4CB} the key points, or \u{1F4D6} the full breakdown. Timestamps are clickable.";
        this.output.append(p);
      } else {
        if (out.text) this.output.append(renderMarkdown(out.text, { onSeek }));
        if (out.busy && !out.text) this.output.append(statusLine(out.status || "Working\u2026"));
        if (out.busy && out.text) this.output.lastElementChild?.classList.add("streaming");
        if (out.error) this.output.append(errorLine(out.error));
        if (out.truncated) this.output.append(statusLine("(Answer was cut off at the length limit.)"));
      }
      const showBar = Boolean(out?.text) && !out.busy;
      this.outputBar.hidden = !showBar;
      this.meta.textContent = showBar ? metaText(s, out) : "";
      this.chatLog.replaceChildren();
      for (const turn of s.chat.display) {
        const bubble = document.createElement("div");
        bubble.className = `msg ${turn.role}`;
        if (turn.role === "user") bubble.textContent = turn.text;
        else {
          if (turn.text) bubble.append(renderMarkdown(turn.text, { onSeek }));
          if (turn.busy && !turn.text) bubble.append(statusLine(turn.status || "Thinking\u2026"));
          if (turn.error) bubble.append(errorLine(turn.error));
        }
        this.chatLog.append(bubble);
      }
      this.clearChatBtn.hidden = s.chat.display.length === 0 || s.chat.busy;
      this.askBtn.disabled = s.chat.busy;
      this.chatInput.disabled = Boolean(this.settings && !this.settings.hasApiKey);
    }
    // ------------------------------------------------------------ actions
    onTab(mode) {
      const s = this.state;
      if (!s) return;
      const out = s.outputs[mode];
      s.activeMode = mode;
      if (!out.text && !out.busy) this.runMode(mode);
      else this.render();
    }
    selectMode(mode) {
      if (!this.state) return;
      this.state.activeMode = mode;
      this.render();
    }
    async runMode(mode, { force = false } = {}) {
      const s = this.state;
      if (!s) return;
      s.activeMode = mode;
      const out = s.outputs[mode];
      if (out.busy) return this.render();
      if (out.text && !force) return this.render();
      if (!await this.ensureKey()) return;
      Object.assign(out, { text: "", error: "", busy: true, truncated: false, status: "Reading the transcript\u2026" });
      this.render();
      try {
        const video = await this.ensureVideo(s);
        out.status = "Asking Claude\u2026";
        this.queueRender();
        const result = await this.stream(s, { kind: "summary", mode, video }, {
          onDelta: (full) => {
            out.text = full;
            this.queueRender();
          }
        });
        Object.assign(out, { text: result.text, truncated: result.truncated, model: result.model });
      } catch (err) {
        out.text = "";
        if (err.name !== "AbortError") out.error = err.message;
      } finally {
        out.busy = false;
        this.queueRender();
      }
    }
    async ask(question) {
      const s = this.state;
      question = question.trim();
      if (!s || !question || s.chat.busy) return;
      if (!await this.ensureKey()) return;
      this.chatInput.value = "";
      autosize(this.chatInput);
      const userTurn = { role: "user", text: question };
      const reply = { role: "assistant", text: "", busy: true, status: "Reading the transcript\u2026" };
      s.chat.display.push(userTurn, reply);
      s.chat.busy = true;
      this.render();
      this.chatLog.lastElementChild?.scrollIntoView({ block: "nearest" });
      const isFirst = s.chat.turns.length === 0;
      try {
        const video = await this.ensureVideo(s);
        const content = isFirst ? firstQuestionText(s, question) : question;
        s.chat.turns.push({ role: "user", content });
        reply.status = "Thinking\u2026";
        this.queueRender();
        const result = await this.stream(s, { kind: "chat", video, turns: s.chat.turns }, {
          onDelta: (full) => {
            reply.text = full;
            this.queueRender();
          }
        });
        reply.text = result.text + (result.truncated ? "\n\n_(cut off at the length limit)_" : "");
        s.chat.turns.push({ role: "assistant", content: result.content });
      } catch (err) {
        if (s.chat.turns.length % 2 === 1) s.chat.turns.pop();
        reply.text = "";
        reply.error = err.name === "AbortError" ? "Cancelled (you left the video)." : err.message;
      } finally {
        reply.busy = false;
        s.chat.busy = false;
        this.queueRender();
      }
    }
    clearChat() {
      if (!this.state || this.state.chat.busy) return;
      this.state.chat = { turns: [], display: [], busy: false };
      this.render();
    }
    async copyActive() {
      const out = this.state?.activeMode && this.state.outputs[this.state.activeMode];
      if (!out?.text) return;
      try {
        await navigator.clipboard.writeText(out.text);
        this.copyBtn.textContent = "Copied";
        setTimeout(() => this.copyBtn.textContent = "Copy", 1200);
      } catch {
        this.copyBtn.textContent = "Copy failed";
      }
    }
    // ------------------------------------------------------------ plumbing
    async ensureKey() {
      if (!this.settings?.hasApiKey) this.settings = await getSettings();
      if (this.settings?.hasApiKey) return true;
      this.render();
      return false;
    }
    ensureVideo(s) {
      if (!s.videoPromise) {
        s.videoPromise = fetchVideo(s.videoId, { log }).then((video) => {
          s.videoInfo = video;
          return video;
        });
        s.videoPromise.catch(() => {
          s.videoPromise = null;
        });
      }
      return s.videoPromise;
    }
    /** Runs one request through the background worker, streaming text back. */
    stream(s, request, { onDelta }) {
      return new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({ name: "claude" });
        let full = "";
        let settled = false;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          s.cancels.delete(cancel);
          try {
            port.disconnect();
          } catch {
          }
          fn(value);
        };
        port.onMessage.addListener((msg) => {
          if (msg.type === "delta") {
            full += msg.text;
            onDelta(full);
          } else if (msg.type === "fallback") {
            full = "";
            onDelta(full);
          } else if (msg.type === "done") {
            finish(resolve, msg);
          } else if (msg.type === "error") {
            if (msg.code === "no-key" && this.settings) this.settings.hasApiKey = false;
            finish(reject, new Error(msg.message));
          }
        });
        port.onDisconnect.addListener(() => {
          finish(reject, new Error("Lost connection to the extension. Reload the page and try again."));
        });
        const cancel = () => {
          try {
            port.postMessage({ type: "abort" });
          } catch {
          }
          const err = new Error("Cancelled");
          err.name = "AbortError";
          finish(reject, err);
        };
        s.cancels.add(cancel);
        port.postMessage({ type: "run", request });
      });
    }
    abortAll(s) {
      for (const cancel of [...s.cancels]) cancel();
    }
  };
  function newState(videoId) {
    const output = () => ({ text: "", busy: false, error: "", status: "", truncated: false, model: "" });
    return {
      videoId,
      videoPromise: null,
      activeMode: null,
      outputs: { tldr: output(), key: output(), deep: output() },
      chat: { turns: [], display: [], busy: false },
      videoInfo: null,
      cancels: /* @__PURE__ */ new Set()
    };
  }
  function firstQuestionText(s, question) {
    const shown = MODE_TABS.filter((t) => s.outputs[t.id].text && !s.outputs[t.id].busy).map(
      (t) => `<${t.id}_summary>
${s.outputs[t.id].text}
</${t.id}_summary>`
    );
    if (!shown.length) return question;
    return `For context, this is what you already told me about the video:

${shown.join("\n\n")}

My question: ${question}`;
  }
  function metaText(s, out) {
    const parts = [];
    if (out.model) parts.push(prettyModel(out.model));
    if (s.videoInfo?.captionLabel) parts.push(`from ${s.videoInfo.captionLabel}`);
    return parts.join(" \xB7 ");
  }
  function prettyModel(id) {
    const m = id.match(/^claude-(\w+)-(\d+)-(\d+)/);
    return m ? `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id;
  }
  function statusLine(text) {
    const p = document.createElement("p");
    p.className = "status";
    const dot = document.createElement("span");
    dot.className = "spinner";
    p.append(dot, document.createTextNode(text));
    return p;
  }
  function errorLine(text) {
    const p = document.createElement("p");
    p.className = "error";
    p.textContent = text;
    return p;
  }
  function noKeyNotice() {
    const wrap = document.createElement("div");
    wrap.className = "notice";
    const p = document.createElement("p");
    p.textContent = 'Add your Anthropic API key once and every video gets a "skip to the point" button.';
    const b = document.createElement("button");
    b.className = "ask-btn";
    b.textContent = "Open settings";
    b.addEventListener("click", () => chrome.runtime.sendMessage({ type: "openOptions" }));
    wrap.append(p, b);
    return wrap;
  }
  function autosize(ta) {
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }
  function seek(seconds) {
    const video = document.querySelector("#movie_player video") || document.querySelector("video.html5-main-video") || document.querySelector("video");
    if (!video) return;
    video.currentTime = seconds;
    video.play?.().catch(() => {
    });
    const player = document.querySelector("#movie_player") || video;
    const rect = player.getBoundingClientRect();
    if (rect.bottom < 80 || rect.top > window.innerHeight - 80) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }
  async function getSettings() {
    try {
      return await chrome.runtime.sendMessage({ type: "getSettings" });
    } catch {
      return null;
    }
  }

  // src/content/main.js
  var panel = new Panel();
  var currentId;
  function currentVideoId() {
    if (location.pathname !== "/watch") return null;
    return new URLSearchParams(location.search).get("v");
  }
  function check() {
    const id = currentVideoId();
    if (id !== currentId) {
      currentId = id;
      panel.setVideo(id);
    }
    if (id) panel.mount();
  }
  document.addEventListener("yt-navigate-finish", check);
  window.addEventListener("popstate", check);
  setInterval(check, 1e3);
  check();
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "shortcut-summarize") panel.shortcut();
  });
})();
