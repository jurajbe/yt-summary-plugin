# Skip the Video

A Brave/Chrome extension that tells you the point of a YouTube video, so you don't have to sit through 25 minutes to find "the trick". It can use any of three AI backends:

- **Ollama Cloud** (default). Big open models on ollama.com. You need a free account and an API key; nothing to install.
- **Local Ollama.** Models running on your own computer. Free and private.
- **Claude.** Needs an Anthropic API key.

A panel appears at the top of the sidebar on every video, with three options:

| Option | What you get |
|---|---|
| ⚡ **The point** | The payoff in 1–3 sentences, the timestamp where it's revealed, and whether the video is worth watching |
| 📋 **Key points** | 5–10 bullet takeaways, each with a timestamp |
| 📖 **Deep dive** | A section-by-section breakdown, plus a list of skippable sponsor segments |

Under the summaries there's a chat box for follow-up questions ("what settings did he use?", "is this actually true?"). Timestamps such as `1:05` are clickable and jump the video to that point.

Shortcut: **Alt+Shift+S** gets "The point" for the current video.

## Install (Brave)

1. Clone this repo, or download it as a ZIP and unzip it.
2. Open `brave://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the **`dist`** folder.
4. The settings page opens. Pick your backend (see below) and click **Save**.
5. Open any YouTube video.

The same steps work in Chrome and Edge (`chrome://extensions`, `edge://extensions`).

### Ollama Cloud (default)

1. Sign in at [ollama.com](https://ollama.com), go to **Settings → Keys**, and create an API key.
2. Paste the key into the settings page.
3. Leave the model on **Auto**, or pick one.

The model list comes from `https://ollama.com/api/tags`. It refreshes automatically **once a day**, and the **Refresh** button fetches it immediately. **Auto** picks the best general-purpose model your account offers, in this order:

1. `gpt-oss:120b`
2. `deepseek-v3.x`
3. `qwen3`
4. `kimi-k2`
5. `glm-4`

If a model gets retired, Auto moves on to the next one, so nothing breaks. Usage limits depend on your Ollama plan.

### Local Ollama

1. Install [Ollama](https://ollama.com/download) and pull a model, e.g. `ollama pull gemma3:12b`.
2. In settings, choose **My computer**. Your installed models are listed automatically.

You don't need to set `OLLAMA_ORIGINS`. Ollama normally refuses requests from browser extensions (403). To get around that, the extension removes the `Origin` header on its own requests to your Ollama server, using a session-scoped `declarativeNetRequest` rule. Web pages are unaffected and still blocked.

The extension also sizes Ollama's context window (`num_ctx`) to each transcript, capped by **Max context** and by the model's own limit. Ollama's small default context would otherwise silently cut off most of a long video. If a video won't fit, the panel tells you instead of summarizing half of it.

Any chat model works. Suggestions, smallest first:

| Model | Download | Needs | Notes |
|---|---|---|---|
| `gemma3:4b` | 3.3 GB | 8 GB RAM | Fast; fine for short videos |
| `llama3.1:8b` | 4.9 GB | 8–16 GB RAM | Reliable, 128k context |
| `qwen3:8b` | 5.2 GB | 16 GB RAM | Strong for its size; reasoning model (effort Low = thinking off) |
| `gemma3:12b` | 8.1 GB | 16 GB RAM | **Best start**: best quality-per-GB for summaries |
| `qwen3:14b` | 9.3 GB | 16–24 GB RAM | Very good summaries and follow-ups |
| `gpt-oss:20b` | 14 GB | 24 GB RAM / 16 GB VRAM | Great on tricky follow-ups |
| `qwen3:30b` | 19 GB | 32 GB RAM | Mixture-of-experts: big-model quality, fast |
| `gemma3:27b` | 17 GB | 32 GB RAM / 24 GB VRAM | Best local quality here |

Models of 12B and up find the actual "trick" much more reliably than 3–4B models.

If your Ollama runs on another machine, enter its address (e.g. `http://192.168.1.20:11434`). Brave asks once for permission to reach it.

### Claude

1. Get an API key at <https://platform.claude.com/settings/keys>.
2. Choose **Claude** and paste the key.
3. Pick a model:
   - Opus 5.5 (default): best quality
   - Sonnet 5.5: faster
   - Haiku 5.5: fastest and cheapest

A 25-minute video costs roughly 3–6 cents on Opus 5.5. The transcript is prompt-cached, so the other two options and follow-up questions are cheaper. For Opus and Sonnet, requests opt into Anthropic's server-side fallback (`fallbacks: "default"`): if the model declines a request on policy grounds, another model answers instead of you getting an error.

## Settings that apply to every backend

- **Thinking effort:** Low by default, which is fastest. For reasoning models (gpt-oss, qwen3, deepseek), Low turns thinking off or down.
- **Answer language:** English by default. Answers come back in this language whatever language the video is in.
- **Auto-summarize:** off by default. When it's on, "The point" runs as soon as a video opens.

## How it works

- **Transcript:** the content script gets the transcript from YouTube. It tries three routes in order, because YouTube changes its internals often:
  1. the "Show transcript" endpoint
  2. the caption track files
  3. opening the transcript panel on the page and reading it
- **Model calls:** all of them happen in the extension's background service worker and stream back to the panel.
  - `src/providers/ollama.js` uses Ollama's `/api/chat`; reasoning-model thinking is hidden from the answer.
  - `src/providers/anthropic.js` uses the official `@anthropic-ai/sdk`.
- **API keys:** stored in `chrome.storage.local`, which is restricted to the extension's own pages. YouTube's page and the content script never see them.
- **Prompt caching (Claude):** the video's title, description and transcript go in one cached block that is identical across the three options and the chat.
- **Prompt injection:** the prompt treats transcript text as data. A video that says "ignore previous instructions" gets reported on rather than obeyed.

Videos without captions or a transcript can't be summarized. The panel tells you when that happens.

## Development

```bash
npm install
npm run build      # bundles src/ → dist/
npm test           # unit tests (transcript parsing, request building)
npm run test:e2e   # loads dist/ into Chromium against a mocked YouTube page, Claude API, Ollama Cloud and local Ollama
```

After changing code, run `npm run build` and click the reload icon on the extension card in `brave://extensions`.

Layout:

```
src/
  manifest.json
  background.js        service worker: routes requests to a provider, streams over a port
  providers/
    ollama.js          Ollama Cloud + local Ollama (origin fix, num_ctx sizing, think handling)
    anthropic.js       Claude via @anthropic-ai/sdk
  cloudModels.js       Ollama Cloud model list, refreshed daily (chrome.alarms)
  messages.js          request building, fallback-aware history handling
  prompts.js           system prompt + the three summary modes
  settings.js
  content/
    main.js            follows YouTube's SPA navigation
    panel.js           the in-page UI (shadow DOM)
    panel-css.js
    markdown.js        safe markdown → DOM (no innerHTML; YouTube enforces Trusted Types)
    transcript.js      transcript extraction
  options/             settings page
dist/                  built extension (committed so you can load it without building)
```
