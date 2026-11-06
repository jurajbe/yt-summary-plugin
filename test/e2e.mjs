// End-to-end test: loads dist/ into Chromium, serves a fake YouTube watch page
// (Playwright routes) and a fake Claude API (local SSE server), then drives the
// panel: summary modes, timestamp seeking, follow-up chat, transcript fallbacks.
//
// Run: npm run test:e2e   (screenshots land in test-results/)

import { createRequire } from 'node:module';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const DIST = path.resolve('dist');
const VIDEO_ID = 'abcDEF12345';

// ------------------------------------------------------------------ fake Claude API

const apiRequests = [];
let nextAnswers = [];

const server = http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    apiRequests.push({ url: req.url, headers: req.headers, body: parsed });
    const answer = nextAnswers.shift() ?? 'Default answer.';
    res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('message_start', {
      type: 'message_start',
      message: {
        id: `msg_${apiRequests.length}`, type: 'message', role: 'assistant', model: parsed.model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 },
      },
    });
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: `sig${apiRequests.length}` } });
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
    const chunks = answer.match(/[\s\S]{1,12}/g);
    let i = 0;
    const tick = () => {
      if (i < chunks.length) {
        send('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: chunks[i++] } });
        return setTimeout(tick, 5);
      }
      send('content_block_stop', { type: 'content_block_stop', index: 1 });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 50 } });
      send('message_stop', { type: 'message_stop' });
      res.end();
    };
    tick();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const apiBase = `http://127.0.0.1:${server.address().port}`;

// ------------------------------------------------------------------ fake Ollama (cloud + local)

function makeOllamaMock({ cloud }) {
  const state = { requests: [], tagsHits: 0, answers: [] };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const entry = { url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
      state.requests.push(entry);
      const json = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      // Real Ollama rejects browser-extension origins unless OLLAMA_ORIGINS allows them.
      const origin = req.headers.origin;
      if (!cloud && origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return json(403, {});
      if (cloud && req.headers.authorization !== 'Bearer good-key') return json(401, { error: 'unauthorized' });

      if (req.url === '/api/tags') {
        state.tagsHits++;
        const models = cloud
          ? [
              { name: 'qwen3-coder:480b', size: 0, details: { parameter_size: '480B' } },
              { name: 'gpt-oss:120b', size: 0, details: { parameter_size: '116.8B' } },
              { name: 'deepseek-v3.1:671b', size: 0, details: { parameter_size: '671B' } },
            ]
          : [
              { name: 'qwen3:8b', size: 5.2e9, details: { parameter_size: '8.2B', family: 'qwen3' } },
              { name: 'nomic-embed-text:latest', size: 2.7e8, details: { family: 'nomic-bert' } },
            ];
        return json(200, { models });
      }
      if (req.url === '/api/show') {
        return json(200, { model_info: { 'qwen3.context_length': 40960 }, capabilities: ['completion', 'thinking'], details: { family: 'qwen3' } });
      }
      if (req.url === '/api/chat') {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        const answer = state.answers.shift() ?? 'Ollama answer.';
        const lines = [
          { message: { role: 'assistant', content: '', thinking: 'hmm' }, done: false },
          { message: { role: 'assistant', content: '<think>inline reasoning</th' }, done: false },
          { message: { role: 'assistant', content: 'ink>\n\n' }, done: false },
          ...answer.match(/[\s\S]{1,10}/g).map((c) => ({ message: { role: 'assistant', content: c }, done: false })),
          { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' },
        ];
        let i = 0;
        const tick = () => {
          if (i < lines.length) {
            res.write(`${JSON.stringify(lines[i++])}\n`);
            return setTimeout(tick, 5);
          }
          res.end();
        };
        return tick();
      }
      json(404, { error: 'not found' });
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, state, base: `http://127.0.0.1:${srv.address().port}` })));
}
const ollamaCloud = await makeOllamaMock({ cloud: true });
const ollamaLocal = await makeOllamaMock({ cloud: false });

// ------------------------------------------------------------------ fake YouTube

const playerResponse = {
  videoDetails: {
    videoId: VIDEO_ID,
    title: 'I tried 47 productivity hacks — only ONE actually worked',
    author: 'Some Channel',
    lengthSeconds: '1500',
    shortDescription: 'Chapters:\n0:00 Intro\n1:05 The trick',
  },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=en&kind=asr`, languageCode: 'en', kind: 'asr', name: { simpleText: 'English (auto-generated)' } },
      ],
    },
  },
};
const initialData = {
  engagementPanels: [{ engagementPanelSectionListRenderer: { content: { continuationItemRenderer: { continuationEndpoint: { getTranscriptEndpoint: { params: 'PARAMS==' } } } } } }],
};

function watchHtml() {
  return `<!doctype html><html dark><head><title>${playerResponse.videoDetails.title} - YouTube</title>
<style>
  html[dark] { --yt-spec-text-primary:#f1f1f1; --yt-spec-text-secondary:#aaa; --yt-spec-base-background:#0f0f0f;
    --yt-spec-badge-chip-background:rgba(255,255,255,0.1); --yt-spec-button-chip-background-hover:rgba(255,255,255,0.2);
    --yt-spec-10-percent-layer:rgba(255,255,255,0.1); --yt-spec-call-to-action:#3ea6ff; }
  body { margin:0; background:#0f0f0f; color:#f1f1f1; font-family:Roboto,Arial,sans-serif; }
  ytd-watch-flexy { display:flex; gap:24px; padding:24px; }
  #primary { flex:1; } #secondary { width:402px; flex:none; }
  video { width:100%; aspect-ratio:16/9; background:#222; border-radius:12px; display:block; }
  .rel { height:94px; margin-bottom:8px; border-radius:8px; background:#272727; }
</style>
<script>var ytcfg = { set() {} };</script>
<script>ytcfg.set({"INNERTUBE_API_KEY":"FAKEKEY","INNERTUBE_CLIENT_VERSION":"2.20261101.00.00"});</script>
<script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};</script>
<script>var ytInitialData = ${JSON.stringify(initialData)};</script>
</head><body>
<ytd-watch-flexy>
  <div id="primary"><div id="movie_player"><video class="html5-main-video" src="/fake-media.wav" preload="auto" muted></video></div>
    <div id="below"><ytd-watch-metadata><h1 style="font-size:20px">${playerResponse.videoDetails.title}</h1></ytd-watch-metadata></div></div>
  <div id="secondary"><div id="secondary-inner"><div class="rel"></div><div class="rel"></div><div class="rel"></div></div></div>
</ytd-watch-flexy>
</body></html>`;
}

function silentWav(seconds) {
  const rate = 8000;
  const data = Buffer.alloc(rate * seconds, 128);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const wav = silentWav(180);

const transcriptApiResponse = {
  actions: [{ updateEngagementPanelAction: { content: { transcriptRenderer: { body: { initialSegments: [
    { transcriptSegmentRenderer: { startMs: '0', snippet: { runs: [{ text: 'hey everyone today I tried 47 hacks' }] } } },
    { transcriptSegmentRenderer: { startMs: '65000', snippet: { runs: [{ text: 'the one that worked: write tomorrow\'s single task tonight' }] } } },
    { transcriptSegmentRenderer: { startMs: '600000', snippet: { runs: [{ text: 'this video is sponsored by' }] } } },
  ] } } } } }],
};
const json3 = { events: [{ tStartMs: 0, segs: [{ utf8: 'caption track text' }] }, { tStartMs: 30000, segs: [{ utf8: 'more' }] }] };

const yt = { transcriptApiStatus: 200, timedtextHits: 0, transcriptApiHits: 0, transcriptApiBodies: [] };

// ------------------------------------------------------------------ run

const userDataDir = await mkdtemp(path.join(tmpdir(), 'ytsum-'));
await mkdir('test-results', { recursive: true });
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1400, height: 900 },
  deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
});

let failed = false;
try {
  await context.route('https://www.youtube.com/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/watch') return route.fulfill({ contentType: 'text/html', body: watchHtml() });
    if (url.pathname === '/fake-media.wav') {
      // Range support makes the media seekable, like real YouTube video.
      const m = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Number(m[2]) : wav.length - 1;
      return route.fulfill({
        status: m ? 206 : 200,
        headers: {
          'Content-Type': 'audio/wav',
          'Accept-Ranges': 'bytes',
          ...(m ? { 'Content-Range': `bytes ${start}-${end}/${wav.length}` } : {}),
        },
        body: wav.subarray(start, end + 1),
      });
    }
    if (url.pathname === '/youtubei/v1/get_transcript') {
      yt.transcriptApiHits++;
      yt.transcriptApiBodies.push(JSON.parse(route.request().postData()));
      if (yt.transcriptApiStatus !== 200) return route.fulfill({ status: yt.transcriptApiStatus, body: '{}' });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(transcriptApiResponse) });
    }
    if (url.pathname === '/api/timedtext') {
      yt.timedtextHits++;
      assert.equal(url.searchParams.get('fmt'), 'json3');
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(json3) });
    }
    return route.fulfill({ status: 404, body: '' });
  });

  const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  await sw.evaluate(
    (base) => chrome.storage.local.set({ provider: 'anthropic', apiKey: 'sk-ant-test-key', apiBaseUrl: base, model: 'claude-opus-5-5', effort: 'low', language: 'English' }),
    apiBase,
  );

  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && console.log('[page error]', m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`https://www.youtube.com/watch?v=${VIDEO_ID}`);

  const panel = page.locator('#yt-summary-claude');
  await panel.locator('.tab').first().waitFor({ timeout: 10000 });
  assert.equal(await page.evaluate(() => document.querySelector('#secondary-inner').firstElementChild.id), 'yt-summary-claude', 'panel mounts at top of sidebar');
  console.log('✓ panel mounted in sidebar');

  // --- The point
  nextAnswers.push('**The point:** Write tomorrow\'s one task tonight.\n\n**Where:** [1:05] he explains it.\n\n**Worth watching?** No — clickbait, the rest is filler.');
  await panel.locator('.tab', { hasText: 'The point' }).click();
  await panel.locator('.output strong', { hasText: 'Worth watching?' }).waitFor({ timeout: 10000 });
  let req = apiRequests.at(-1).body;
  const headers = apiRequests.at(-1).headers;
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.fallbacks, 'default');
  assert.match(headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.ok(headers['x-api-key'] === 'sk-ant-test-key' || headers.authorization === 'Bearer sk-ant-test-key', 'API key sent');
  assert.deepEqual(req.output_config, { effort: 'low' });
  assert.equal(req.stream, true);
  assert.equal(req.messages.length, 1);
  assert.deepEqual(req.messages[0].content[0].cache_control, { type: 'ephemeral' });
  assert.match(req.messages[0].content[0].text, /\[1:05\] the one that worked/);
  assert.match(req.messages[0].content[0].text, /<title>I tried 47 productivity hacks/);
  assert.match(req.system, /Write your answer in English/);
  assert.equal(yt.transcriptApiBodies[0].params, 'PARAMS==');
  assert.equal(yt.timedtextHits, 0);
  console.log('✓ "The point" streamed; request has caching, effort, fallbacks, transcript');

  // --- timestamp click seeks the video
  await page.waitForFunction(() => document.querySelector('video').readyState >= 1);
  await panel.locator('.output .ts', { hasText: '1:05' }).click();
  await page.waitForFunction(() => Math.abs(document.querySelector('video').currentTime - 65) < 1);
  console.log('✓ clicking [1:05] seeks the video to 65s');
  await page.evaluate(() => document.querySelector('video').pause());

  await panel.screenshot({ path: 'test-results/panel-the-point.png' });

  // --- Key points (transcript reused, no new YouTube fetch)
  nextAnswers.push('- [0:00] Tested 47 hacks over a month.\n- [1:05] Only one worked: **plan one task the night before**.\n- [10:00] Sponsor read.\n\n**Bottom line:** pick tomorrow\'s single task tonight.');
  await panel.locator('.tab', { hasText: 'Key points' }).click();
  await panel.locator('.output li').nth(2).waitFor({ timeout: 10000 });
  assert.equal(yt.transcriptApiHits, 1, 'transcript fetched once per video');
  const tldrContext = apiRequests[0].body.messages[0].content[0];
  assert.deepEqual(apiRequests.at(-1).body.messages[0].content[0], tldrContext, 'cache prefix identical across modes');
  console.log('✓ "Key points" reuses the transcript with an identical cached prefix');

  // switching back shows the stored answer without a new request
  const before = apiRequests.length;
  await panel.locator('.tab', { hasText: 'The point' }).click();
  await panel.locator('.output strong', { hasText: 'The point:' }).waitFor();
  assert.equal(apiRequests.length, before);
  console.log('✓ switching tabs reuses earlier answers');

  // --- follow-up chat
  nextAnswers.push('At [1:05] he says to write it on paper and leave it on your keyboard.');
  const input = panel.locator('textarea');
  await input.fill('how exactly does he do it? k j f');
  await input.press('Enter');
  await panel.locator('.msg.assistant .ts', { hasText: '1:05' }).waitFor({ timeout: 10000 });
  req = apiRequests.at(-1).body;
  assert.equal(req.messages.length, 1);
  assert.match(req.messages[0].content[1].text, /already told me about the video/);
  assert.match(req.messages[0].content[1].text, /My question: how exactly does he do it\? k j f/);
  assert.deepEqual(req.messages[0].content[0], tldrContext);

  nextAnswers.push('Yes, he says it took about two weeks to stick.');
  await input.fill('did it work long term?');
  await panel.locator('.ask-btn').click();
  await panel.locator('.msg.assistant', { hasText: 'two weeks' }).waitFor({ timeout: 10000 });
  req = apiRequests.at(-1).body;
  assert.equal(req.messages.length, 3);
  assert.equal(req.messages[1].role, 'assistant');
  assert.deepEqual(req.messages[1].content[0], { type: 'thinking', thinking: '', signature: `sig${apiRequests.length - 1}` }, 'thinking block echoed unchanged');
  assert.equal(req.messages[2].content, 'did it work long term?');
  console.log('✓ follow-up chat keeps history and echoes assistant blocks unchanged');

  await panel.screenshot({ path: 'test-results/panel-chat.png' });

  // --- Key not reachable from the page / content script world
  const pageSeesKey = await page.evaluate(() => document.documentElement.outerHTML.includes('sk-ant-test-key'));
  assert.equal(pageSeesKey, false);

  // --- second video: transcript API fails → falls back to caption track
  yt.transcriptApiStatus = 500;
  const page2 = await context.newPage();
  await page2.goto(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
  const panel2 = page2.locator('#yt-summary-claude');
  nextAnswers.push('Fallback worked.');
  await panel2.locator('.tab', { hasText: 'Deep dive' }).click();
  await panel2.locator('.output', { hasText: 'Fallback worked.' }).waitFor({ timeout: 15000 });
  assert.ok(yt.timedtextHits >= 1);
  assert.match(apiRequests.at(-1).body.messages[0].content[0].text, /\[0:30\] more/);
  assert.match(apiRequests.at(-1).body.messages[0].content[0].text, /English \(auto-generated\) captions/);
  console.log('✓ falls back to the caption track when the transcript API fails');

  // --- API error surfaces in the panel
  await sw.evaluate(() => chrome.storage.local.set({ apiBaseUrl: 'http://127.0.0.1:9' }));
  await panel2.locator('.tab', { hasText: 'Key points' }).click();
  await panel2.locator('.output .error').waitFor({ timeout: 30000 });
  console.log('✓ connection errors are shown:', await panel2.locator('.output .error').textContent());

  // --- no key → settings prompt
  await sw.evaluate(() => chrome.storage.local.set({ apiKey: '' }));
  const page3 = await context.newPage();
  await page3.goto(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
  await page3.locator('#yt-summary-claude .notice').waitFor({ timeout: 10000 });
  console.log('✓ missing API key shows the settings prompt');

  // --- options page renders
  const extId = new URL(sw.url()).host;
  const opts = await context.newPage();
  await opts.goto(`chrome-extension://${extId}/options.html`);
  await opts.locator('#model option').first().waitFor({ state: 'attached' });
  await opts.fill('#apiKey', 'sk-ant-saved');
  await opts.click('button[type=submit]');
  await opts.locator('#status.ok').waitFor();
  assert.equal(await sw.evaluate(() => chrome.storage.local.get('apiKey').then((s) => s.apiKey)), 'sk-ant-saved');
  await opts.screenshot({ path: 'test-results/options.png', fullPage: true });
  console.log('✓ options page saves settings');

  // ================================================================ Ollama Cloud
  yt.transcriptApiStatus = 200;
  await sw.evaluate(
    (base) => chrome.storage.local.set({ provider: 'ollama', ollamaMode: 'cloud', ollamaApiKey: 'good-key', ollamaCloudModel: '', ollamaCloudBaseUrl: base, cloudModels: [], cloudModelsFetchedAt: 0 }),
    ollamaCloud.base,
  );
  const alarm = await sw.evaluate(() => chrome.alarms.get('refresh-cloud-models'));
  assert.equal(alarm?.periodInMinutes, 24 * 60, 'daily refresh alarm registered');
  console.log('✓ daily cloud-model refresh alarm is registered');

  await opts.reload();
  await opts.locator('#cloudStatus.ok').waitFor({ timeout: 10000 });
  assert.match(await opts.locator('#cloudStatus').textContent(), /3 cloud models · updated just now · refreshes daily/);
  assert.match(await opts.locator('#ollamaCloudModel option').first().textContent(), /Auto — best available \(now: gpt-oss:120b\)/);
  assert.equal(ollamaCloud.state.tagsHits, 1);
  await opts.screenshot({ path: 'test-results/options-ollama-cloud.png', fullPage: true });

  // Cached list is reused while fresh, refetched once it's over a day old.
  await opts.reload();
  await opts.locator('#cloudStatus.ok').waitFor();
  assert.equal(ollamaCloud.state.tagsHits, 1, 'fresh cache reused');
  await sw.evaluate(() => chrome.storage.local.set({ cloudModelsFetchedAt: Date.now() - 25 * 3600 * 1000 }));
  await opts.reload();
  await opts.locator('#cloudStatus.ok').waitFor();
  assert.equal(ollamaCloud.state.tagsHits, 2, 'stale cache refreshed');
  console.log('✓ cloud model list cached, refreshed when over a day old');

  ollamaCloud.state.answers.push('**The point:** Cloud says: plan tonight.\n\n**Where:** [1:05]');
  const page4 = await context.newPage();
  await page4.goto(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
  const panel4 = page4.locator('#yt-summary-claude');
  await panel4.locator('.tab', { hasText: 'The point' }).click();
  await panel4.locator('.output', { hasText: 'Cloud says: plan tonight.' }).waitFor({ timeout: 10000 });
  await panel4.locator('.meta', { hasText: 'gpt-oss:120b · Ollama Cloud' }).waitFor();
  const outText = await panel4.locator('.output').innerText();
  assert.ok(!/think|reasoning/i.test(outText), 'thinking stripped from answer');
  let chat = ollamaCloud.state.requests.at(-1);
  assert.equal(chat.url, '/api/chat');
  assert.equal(chat.headers.authorization, 'Bearer good-key');
  assert.equal(chat.body.model, 'gpt-oss:120b');
  assert.equal(chat.body.think, 'low');
  assert.equal(chat.body.stream, true);
  assert.equal(chat.body.options, undefined);
  assert.equal(chat.body.messages[0].role, 'system');
  assert.match(chat.body.messages[1].content, /\[1:05\] the one that worked/);
  await panel4.screenshot({ path: 'test-results/panel-ollama-cloud.png' });
  console.log('✓ Ollama Cloud: auto-picked gpt-oss:120b, bearer key, thinking hidden');

  // Follow-up on Ollama keeps plain-text history
  ollamaCloud.state.answers.push('He uses a paper note.');
  await panel4.locator('textarea').fill('how?');
  await panel4.locator('textarea').press('Enter');
  await panel4.locator('.msg.assistant', { hasText: 'paper note' }).waitFor({ timeout: 10000 });
  ollamaCloud.state.answers.push('Two weeks.');
  await panel4.locator('textarea').fill('how long?');
  await panel4.locator('textarea').press('Enter');
  await panel4.locator('.msg.assistant', { hasText: 'Two weeks.' }).waitFor({ timeout: 10000 });
  chat = ollamaCloud.state.requests.at(-1);
  assert.deepEqual(chat.body.messages.slice(2), [
    { role: 'assistant', content: 'He uses a paper note.' },
    { role: 'user', content: 'how long?' },
  ]);
  console.log('✓ Ollama follow-up chat keeps history');

  // Wrong key → clear error
  await sw.evaluate(() => chrome.storage.local.set({ ollamaApiKey: 'bad-key' }));
  await panel4.locator('.tab', { hasText: 'Deep dive' }).click();
  await panel4.locator('.output .error', { hasText: 'rejected the API key' }).waitFor({ timeout: 10000 });
  console.log('✓ bad Ollama key shows a clear error');

  // ================================================================ local Ollama
  await sw.evaluate(
    (base) => chrome.storage.local.set({ ollamaMode: 'local', ollamaUrl: base, ollamaModel: 'qwen3:8b' }),
    ollamaLocal.base,
  );
  await opts.reload();
  await opts.locator('#ollamaStatus.ok').waitFor({ timeout: 10000 }).catch(async (e) => {
    console.log('ollamaStatus:', await opts.locator('#ollamaStatus').textContent(), JSON.stringify(ollamaLocal.state.requests.map((r) => [r.url, r.headers.origin])));
    throw e;
  });
  assert.deepEqual(await opts.locator('#ollamaModel option').allTextContents(), ['qwen3:8b (8.2B) · 5.2 GB'], 'embedding models filtered out');
  console.log('✓ settings page lists local models (Origin header stripped, no 403)');

  ollamaLocal.state.answers.push('- [0:00] Local model works.');
  const page5 = await context.newPage();
  await page5.goto(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
  const panel5 = page5.locator('#yt-summary-claude');
  await panel5.locator('.tab', { hasText: 'Key points' }).click();
  await panel5.locator('.output', { hasText: 'Local model works.' }).waitFor({ timeout: 10000 });
  chat = ollamaLocal.state.requests.at(-1);
  assert.equal(chat.url, '/api/chat');
  assert.equal(chat.headers.origin, undefined, 'Origin header removed by the DNR rule');
  assert.equal(chat.body.model, 'qwen3:8b');
  assert.equal(chat.body.think, false, 'effort low turns thinking off');
  assert.ok(chat.body.options.num_ctx >= 8192 && chat.body.options.num_ctx <= 32768);
  await panel5.locator('.meta', { hasText: 'qwen3:8b · Ollama' }).waitFor();
  console.log(`✓ local Ollama: num_ctx ${chat.body.options.num_ctx}, think off, no 403`);

  // Web pages still can't reach local Ollama through us (rule only covers the extension).
  const pageOrigin = await page5.evaluate(async (base) => {
    try {
      const r = await fetch(`${base}/api/tags`);
      return r.status;
    } catch {
      return 'blocked';
    }
  }, ollamaLocal.base);
  assert.notEqual(pageOrigin, 200, 'youtube.com page must not get through to Ollama');
  console.log(`✓ web pages still blocked from local Ollama (${pageOrigin})`);

  console.log('\nAll e2e checks passed.');
} catch (err) {
  failed = true;
  console.error(err);
  for (const p of context.pages()) await p.screenshot({ path: `test-results/failure-${context.pages().indexOf(p)}.png` }).catch(() => {});
} finally {
  await context.close();
  server.close();
  ollamaCloud.srv.close();
  ollamaLocal.srv.close();
  process.exitCode = failed ? 1 : 0;
}
