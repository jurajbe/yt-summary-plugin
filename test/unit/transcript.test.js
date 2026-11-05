import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAssignedJson,
  parseWatchPage,
  parseJson3,
  parseTranscriptApiResponse,
  findTranscriptParams,
  buildTranscriptParams,
  pickTrack,
  segmentsToText,
  parseClock,
} from '../../src/content/transcript.js';

test('extractAssignedJson handles braces and quotes inside strings', () => {
  const html = `<script>var ytInitialPlayerResponse = {"a":"}{ \\" }","b":{"c":[1,2]}};var x = 1;</script>`;
  assert.deepEqual(extractAssignedJson(html, 'ytInitialPlayerResponse'), { a: '}{ " }', b: { c: [1, 2] } });
  assert.equal(extractAssignedJson(html, 'ytInitialData'), null);
});

test('parseWatchPage pulls player response, initial data and innertube config', () => {
  const html = `
    <script>ytcfg.set({"INNERTUBE_API_KEY":"KEY123","INNERTUBE_CLIENT_VERSION":"2.20261101.01.00","VISITOR_DATA":"VD"});</script>
    <script>var ytInitialPlayerResponse = {"videoDetails":{"title":"T","author":"A","lengthSeconds":"90"}};</script>
    <script>window["ytInitialData"] = {"x":1};</script>`;
  const page = parseWatchPage(html);
  assert.equal(page.apiKey, 'KEY123');
  assert.equal(page.clientVersion, '2.20261101.01.00');
  assert.equal(page.visitorData, 'VD');
  assert.equal(page.playerResponse.videoDetails.title, 'T');
  assert.deepEqual(page.initialData, { x: 1 });
});

test('parseJson3 joins segments and skips blank events', () => {
  const segs = parseJson3({
    events: [
      { tStartMs: 0, segs: [{ utf8: 'hello' }, { utf8: ' world' }] },
      { tStartMs: 1500, segs: [{ utf8: '\n' }] },
      { tStartMs: 2000 },
      { tStartMs: 3200, segs: [{ utf8: 'next' }] },
    ],
  });
  assert.deepEqual(segs, [
    { start: 0, text: 'hello world' },
    { start: 3.2, text: 'next' },
  ]);
});

test('parseTranscriptApiResponse finds segments anywhere, in time order', () => {
  const json = {
    actions: [
      {
        updateEngagementPanelAction: {
          content: {
            transcriptRenderer: {
              body: {
                initialSegments: [
                  { transcriptSegmentRenderer: { startMs: '0', snippet: { runs: [{ text: 'first ' }, { text: 'line' }] } } },
                  { transcriptSegmentRenderer: { startMs: '65000', snippet: { simpleText: 'second' } } },
                  { transcriptSectionHeaderRenderer: { startMs: '60000' } },
                ],
              },
            },
          },
        },
      },
    ],
  };
  assert.deepEqual(parseTranscriptApiResponse(json), [
    { start: 0, text: 'first line' },
    { start: 65, text: 'second' },
  ]);
});

test('findTranscriptParams digs the endpoint params out of ytInitialData', () => {
  const data = { engagementPanels: [{ a: { content: { continuationItemRenderer: { continuationEndpoint: { getTranscriptEndpoint: { params: 'P==' } } } } } }] };
  assert.equal(findTranscriptParams(data), 'P==');
  assert.equal(findTranscriptParams(null), null);
});

test('buildTranscriptParams encodes the video id as protobuf field 1', () => {
  const b = Buffer.from(buildTranscriptParams('dQw4w9WgXcQ'), 'base64');
  assert.equal(b[0], 0x0a);
  assert.equal(b[1], 11);
  assert.equal(b.subarray(2).toString(), 'dQw4w9WgXcQ');
});

test('pickTrack prefers human captions in the spoken language, then auto-generated', () => {
  const asrDe = { languageCode: 'de', kind: 'asr' };
  const manualEn = { languageCode: 'en' };
  const manualDe = { languageCode: 'de' };
  assert.equal(pickTrack([manualEn, asrDe, manualDe]), manualDe);
  assert.equal(pickTrack([manualEn, asrDe]), asrDe);
  assert.equal(pickTrack([{ languageCode: 'fr' }, manualEn]), manualEn);
});

test('segmentsToText merges fragments into ~20s timestamped lines', () => {
  const text = segmentsToText([
    { start: 0, text: 'a' },
    { start: 5, text: 'b\nc' },
    { start: 21, text: 'd' },
    { start: 3725, text: 'late' },
  ]);
  assert.equal(text, '[0:00] a b c\n[0:21] d\n[1:02:05] late');
});

test('parseClock', () => {
  assert.equal(parseClock('4:05'), 245);
  assert.equal(parseClock('1:02:17'), 3737);
});
