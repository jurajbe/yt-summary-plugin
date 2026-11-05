# Skip the Video

A Brave/Chrome extension that tells you the point of a YouTube video, so you don't have to sit through 25 minutes to find "the trick". It uses Claude.

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
4. The settings page opens. Paste your Anthropic API key (get one at <https://platform.claude.com/settings/keys>) and click **Save**.
5. Open any YouTube video.

The same steps work in Chrome and Edge (`chrome://extensions`, `edge://extensions`).

## Settings

Click the extension's toolbar icon, or the ⚙ in the panel.

- **Model:** Claude Opus 5.5 (default, best quality), Sonnet 5.5 (faster and cheaper) or Haiku 5.5 (fastest and cheapest).
- **Thinking effort:** Low by default, which keeps answers quick. Raise it if you ask hard follow-up questions.
- **Answer language:** English by default. Answers come back in this language whatever language the video is in.
- **Auto-summarize:** off by default. When it's on, "The point" runs as soon as a video opens, which spends API credits on every video you open.

## Cost

You pay Anthropic directly for API usage. A 25-minute video's transcript is about 6–8k tokens. On Opus 5.5 that works out to roughly 3–6 cents for the first summary. The transcript is prompt-cached, so the other two options and follow-up questions within a few minutes cost much less. Haiku 5.5 costs about 1/40th as much.

## How it works

- **Transcript:** the content script gets the transcript from YouTube. It tries three routes in order, because YouTube changes its internals often:
  1. the "Show transcript" endpoint
  2. the caption track files
  3. opening the transcript panel on the page and reading it
- **Claude calls:** these happen only in the extension's background service worker (`src/background.js`), using the official `@anthropic-ai/sdk` with streaming.
- **API key:** stored in `chrome.storage.local`, which is restricted to the extension's own pages. YouTube's page and the content script never see it.
- **Refusal fallback:** for Opus/Sonnet the requests opt into Anthropic's server-side fallback (`fallbacks: "default"`). If the model declines a request on policy grounds, another model answers instead of you getting an error.
- **Prompt caching:** the video's title, description and transcript go in one cached block that is identical across the three options and the chat.
- **Prompt injection:** the prompt treats transcript text as data. A video that says "ignore previous instructions" gets reported on rather than obeyed.

Videos without captions or a transcript can't be summarized. The panel tells you when that happens.

## Development

```bash
npm install
npm run build      # bundles src/ → dist/
npm test           # unit tests (transcript parsing, request building)
npm run test:e2e   # loads dist/ into Chromium against a mocked YouTube page and mocked Claude API
```

After changing code, run `npm run build` and click the reload icon on the extension card in `brave://extensions`.

Layout:

```
src/
  manifest.json
  background.js        service worker: Claude API calls, streaming over a port
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
