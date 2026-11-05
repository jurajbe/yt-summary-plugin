import { fetchVideo } from './transcript.js';
import { renderMarkdown } from './markdown.js';
import { PANEL_CSS } from './panel-css.js';

const MODE_TABS = [
  { id: 'tldr', icon: '⚡', label: 'The point', hint: 'Just tell me the trick' },
  { id: 'key', icon: '📋', label: 'Key points', hint: 'Bullet takeaways with timestamps' },
  { id: 'deep', icon: '📖', label: 'Deep dive', hint: 'Section-by-section breakdown' },
];

const log = (...args) => console.debug('[yt-summary]', ...args);

export class Panel {
  constructor() {
    this.host = document.createElement('div');
    this.host.id = 'yt-summary-claude';
    const root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    root.appendChild(style);
    this.root = root;
    this.cache = new Map(); // videoId → state
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
    this.chatInput.value = '';
    this.render();

    this.settings = await getSettings();
    this.render();
    if (this.settings?.autoSummarize && this.settings.hasApiKey && !state.outputs.tldr.text && this.state === state) {
      this.runMode('tldr');
    }
  }

  /** Put the panel at the top of the sidebar, or under the title on narrow layouts. */
  mount() {
    const flexy = document.querySelector('ytd-watch-flexy');
    if (!flexy) return;
    const secondary = flexy.querySelector('#secondary-inner') || flexy.querySelector('#secondary');
    const below = flexy.querySelector('#below');
    const useSidebar = secondary && secondary.getClientRects().length > 0 && secondary.offsetWidth > 200;
    if (useSidebar) {
      if (this.host.parentElement !== secondary || secondary.firstElementChild !== this.host) secondary.prepend(this.host);
    } else if (below) {
      const anchor = below.querySelector(':scope > ytd-watch-metadata');
      if (this.host.parentElement !== below) {
        if (anchor) anchor.after(this.host);
        else below.prepend(this.host);
      }
    }
  }

  shortcut() {
    if (!this.state) return;
    this.setCollapsed(false);
    this.host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (!this.state.outputs.tldr.text && !this.state.outputs.tldr.busy) this.runMode('tldr');
    else this.selectMode('tldr');
  }

  // ------------------------------------------------------------ DOM

  build() {
    const el = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    };

    const panel = el('section', 'panel');

    const header = el('header');
    const title = el('div', 'title');
    title.append(el('span', 'logo', '⚡'), el('span', null, 'Skip the video'));
    const headerActions = el('div', 'header-actions');
    const settingsBtn = el('button', 'icon-btn', '⚙');
    settingsBtn.title = 'Settings (API key, model, language)';
    settingsBtn.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openOptions' }));
    this.collapseBtn = el('button', 'icon-btn', '▾');
    this.collapseBtn.title = 'Collapse';
    this.collapseBtn.addEventListener('click', () => this.setCollapsed(!this.collapsed));
    headerActions.append(settingsBtn, this.collapseBtn);
    header.append(title, headerActions);
    title.addEventListener('click', () => this.collapsed && this.setCollapsed(false));

    this.body = el('div', 'body');

    this.tabs = el('div', 'tabs');
    this.tabButtons = {};
    for (const t of MODE_TABS) {
      const b = el('button', 'tab');
      b.append(el('span', 'tab-icon', t.icon), el('span', null, t.label));
      b.title = t.hint;
      b.addEventListener('click', () => this.onTab(t.id));
      this.tabButtons[t.id] = b;
      this.tabs.appendChild(b);
    }

    this.output = el('div', 'output');
    this.outputBar = el('div', 'output-bar');
    this.meta = el('span', 'meta');
    this.copyBtn = el('button', 'small-btn', 'Copy');
    this.copyBtn.addEventListener('click', () => this.copyActive());
    this.redoBtn = el('button', 'small-btn', '↻ Redo');
    this.redoBtn.title = 'Generate this summary again';
    this.redoBtn.addEventListener('click', () => this.state && this.runMode(this.state.activeMode, { force: true }));
    this.outputBar.append(this.meta, this.copyBtn, this.redoBtn);

    this.chatLog = el('div', 'chat-log');
    const form = el('form', 'chat-form');
    this.chatInput = el('textarea');
    this.chatInput.rows = 1;
    this.chatInput.placeholder = 'Ask anything about this video…';
    // Stop YouTube's keyboard shortcuts (k, j, f, space…) from firing while typing.
    for (const type of ['keydown', 'keyup', 'keypress']) {
      this.chatInput.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type === 'keydown' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          form.requestSubmit();
        }
      });
    }
    this.chatInput.addEventListener('input', () => autosize(this.chatInput));
    this.askBtn = el('button', 'ask-btn', 'Ask');
    this.askBtn.type = 'submit';
    form.append(this.chatInput, this.askBtn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.ask(this.chatInput.value);
    });
    this.clearChatBtn = el('button', 'small-btn clear-chat', 'Clear chat');
    this.clearChatBtn.type = 'button';
    this.clearChatBtn.addEventListener('click', () => this.clearChat());

    this.body.append(this.tabs, this.output, this.outputBar, this.chatLog, form, this.clearChatBtn);
    panel.append(header, this.body);
    this.root.appendChild(panel);
  }

  setCollapsed(collapsed) {
    this.collapsed = collapsed;
    this.body.hidden = collapsed;
    this.collapseBtn.textContent = collapsed ? '▸' : '▾';
    this.collapseBtn.title = collapsed ? 'Expand' : 'Collapse';
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
      b.classList.toggle('active', s.activeMode === t.id);
      b.classList.toggle('busy', s.outputs[t.id].busy);
      b.classList.toggle('done', Boolean(s.outputs[t.id].text) && !s.outputs[t.id].busy);
    }

    // ---- summary output
    this.output.replaceChildren();
    const out = s.activeMode ? s.outputs[s.activeMode] : null;
    if (this.settings && !this.settings.hasApiKey) {
      this.output.append(noKeyNotice());
    } else if (!out) {
      const p = document.createElement('p');
      p.className = 'placeholder';
      p.textContent = 'Pick one: ⚡ the payoff in 3 sentences, 📋 the key points, or 📖 the full breakdown. Timestamps are clickable.';
      this.output.append(p);
    } else {
      if (out.text) this.output.append(renderMarkdown(out.text, { onSeek }));
      if (out.busy && !out.text) this.output.append(statusLine(out.status || 'Working…'));
      if (out.busy && out.text) this.output.lastElementChild?.classList.add('streaming');
      if (out.error) this.output.append(errorLine(out.error));
      if (out.truncated) this.output.append(statusLine('(Answer was cut off at the length limit.)'));
    }
    const showBar = Boolean(out?.text) && !out.busy;
    this.outputBar.hidden = !showBar;
    this.meta.textContent = showBar ? metaText(s, out) : '';

    // ---- chat
    this.chatLog.replaceChildren();
    for (const turn of s.chat.display) {
      const bubble = document.createElement('div');
      bubble.className = `msg ${turn.role}`;
      if (turn.role === 'user') bubble.textContent = turn.text;
      else {
        if (turn.text) bubble.append(renderMarkdown(turn.text, { onSeek }));
        if (turn.busy && !turn.text) bubble.append(statusLine(turn.status || 'Thinking…'));
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

    if (!(await this.ensureKey())) return;
    Object.assign(out, { text: '', error: '', busy: true, truncated: false, status: 'Reading the transcript…' });
    this.render();

    try {
      const video = await this.ensureVideo(s);
      out.status = 'Asking Claude…';
      this.queueRender();
      const result = await this.stream(s, { kind: 'summary', mode, video }, {
        onDelta: (full) => {
          out.text = full;
          this.queueRender();
        },
      });
      Object.assign(out, { text: result.text, truncated: result.truncated, model: result.model });
    } catch (err) {
      out.text = '';
      // A cancelled run (user left the video) just resets so it can be re-run.
      if (err.name !== 'AbortError') out.error = err.message;
    } finally {
      out.busy = false;
      this.queueRender();
    }
  }

  async ask(question) {
    const s = this.state;
    question = question.trim();
    if (!s || !question || s.chat.busy) return;
    if (!(await this.ensureKey())) return;

    this.chatInput.value = '';
    autosize(this.chatInput);
    const userTurn = { role: 'user', text: question };
    const reply = { role: 'assistant', text: '', busy: true, status: 'Reading the transcript…' };
    s.chat.display.push(userTurn, reply);
    s.chat.busy = true;
    this.render();
    this.chatLog.lastElementChild?.scrollIntoView({ block: 'nearest' });

    const isFirst = s.chat.turns.length === 0;
    try {
      const video = await this.ensureVideo(s);
      // The first question carries the summaries already shown, so "what did you
      // mean by point 3?" works. It is fixed from then on (append-only history).
      const content = isFirst ? firstQuestionText(s, question) : question;
      s.chat.turns.push({ role: 'user', content });
      reply.status = 'Thinking…';
      this.queueRender();
      const result = await this.stream(s, { kind: 'chat', video, turns: s.chat.turns }, {
        onDelta: (full) => {
          reply.text = full;
          this.queueRender();
        },
      });
      reply.text = result.text + (result.truncated ? '\n\n_(cut off at the length limit)_' : '');
      s.chat.turns.push({ role: 'assistant', content: result.content });
    } catch (err) {
      // Drop the unanswered question from the history so roles keep alternating.
      if (s.chat.turns.length % 2 === 1) s.chat.turns.pop();
      reply.text = '';
      reply.error = err.name === 'AbortError' ? 'Cancelled (you left the video).' : err.message;
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
      this.copyBtn.textContent = 'Copied';
      setTimeout(() => (this.copyBtn.textContent = 'Copy'), 1200);
    } catch {
      this.copyBtn.textContent = 'Copy failed';
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
        s.videoPromise = null; // allow a retry
      });
    }
    return s.videoPromise;
  }

  /** Runs one request through the background worker, streaming text back. */
  stream(s, request, { onDelta }) {
    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'claude' });
      let full = '';
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        s.cancels.delete(cancel);
        try {
          port.disconnect();
        } catch {
          // already gone
        }
        fn(value);
      };

      port.onMessage.addListener((msg) => {
        if (msg.type === 'delta') {
          full += msg.text;
          onDelta(full);
        } else if (msg.type === 'fallback') {
          // Another model took over after a decline; restart the visible text.
          full = '';
          onDelta(full);
        } else if (msg.type === 'done') {
          finish(resolve, msg);
        } else if (msg.type === 'error') {
          if (msg.code === 'no-key' && this.settings) this.settings.hasApiKey = false;
          finish(reject, new Error(msg.message));
        }
      });
      port.onDisconnect.addListener(() => {
        finish(reject, new Error('Lost connection to the extension. Reload the page and try again.'));
      });
      const cancel = () => {
        try {
          port.postMessage({ type: 'abort' });
        } catch {
          // ignore
        }
        const err = new Error('Cancelled');
        err.name = 'AbortError';
        finish(reject, err);
      };
      s.cancels.add(cancel);
      port.postMessage({ type: 'run', request });
    });
  }

  abortAll(s) {
    for (const cancel of [...s.cancels]) cancel();
  }
}

// ------------------------------------------------------------ helpers

function newState(videoId) {
  const output = () => ({ text: '', busy: false, error: '', status: '', truncated: false, model: '' });
  return {
    videoId,
    videoPromise: null,
    activeMode: null,
    outputs: { tldr: output(), key: output(), deep: output() },
    chat: { turns: [], display: [], busy: false },
    videoInfo: null,
    cancels: new Set(),
  };
}

function firstQuestionText(s, question) {
  const shown = MODE_TABS.filter((t) => s.outputs[t.id].text && !s.outputs[t.id].busy).map(
    (t) => `<${t.id}_summary>\n${s.outputs[t.id].text}\n</${t.id}_summary>`,
  );
  if (!shown.length) return question;
  return `For context, this is what you already told me about the video:\n\n${shown.join('\n\n')}\n\nMy question: ${question}`;
}

function metaText(s, out) {
  const parts = [];
  if (out.model) parts.push(prettyModel(out.model));
  if (s.videoInfo?.captionLabel) parts.push(`from ${s.videoInfo.captionLabel}`);
  return parts.join(' · ');
}

function prettyModel(id) {
  const m = id.match(/^claude-(\w+)-(\d+)-(\d+)/);
  return m ? `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id;
}

function statusLine(text) {
  const p = document.createElement('p');
  p.className = 'status';
  const dot = document.createElement('span');
  dot.className = 'spinner';
  p.append(dot, document.createTextNode(text));
  return p;
}

function errorLine(text) {
  const p = document.createElement('p');
  p.className = 'error';
  p.textContent = text;
  return p;
}

function noKeyNotice() {
  const wrap = document.createElement('div');
  wrap.className = 'notice';
  const p = document.createElement('p');
  p.textContent = 'Add your Anthropic API key once and every video gets a "skip to the point" button.';
  const b = document.createElement('button');
  b.className = 'ask-btn';
  b.textContent = 'Open settings';
  b.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openOptions' }));
  wrap.append(p, b);
  return wrap;
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
}

function seek(seconds) {
  const video = document.querySelector('#movie_player video') || document.querySelector('video.html5-main-video') || document.querySelector('video');
  if (!video) return;
  video.currentTime = seconds;
  video.play?.().catch(() => {});
  const player = document.querySelector('#movie_player') || video;
  const rect = player.getBoundingClientRect();
  if (rect.bottom < 80 || rect.top > window.innerHeight - 80) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

async function getSettings() {
  try {
    return await chrome.runtime.sendMessage({ type: 'getSettings' });
  } catch {
    return null;
  }
}
