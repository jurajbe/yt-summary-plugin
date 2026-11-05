// Styles live inside the panel's shadow root. YouTube's theme variables
// (--yt-spec-*) inherit through it, so the panel follows light/dark mode.
export const PANEL_CSS = `
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
.streaming::after { content: "▍"; color: var(--accent); animation: pulse 0.9s step-end infinite; }

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
