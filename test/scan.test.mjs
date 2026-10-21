import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSearchRequest, parseSearchResponse, searchDomain } from '../src/transparency.mjs';
import { buildReport, nextState, normaliseName } from '../src/classify.mjs';
import { summaryMessage, creativeReply, esc } from '../src/slack.mjs';
import { pickCaptures } from '../src/run.mjs';
import { cleanAdText } from '../src/capture.mjs';

const page1 = JSON.parse(readFileSync(new URL('./fixtures/search-page1.json', import.meta.url)));
const page2 = JSON.parse(readFileSync(new URL('./fixtures/search-page2.json', import.meta.url)));
const NOW = 1761000000 * 1000;
const target = { domain: 'directmeds.com', officialAdvertiserNames: ['Direct Meds LLC'], officialAdvertiserIds: [] };

function fakeFetch(pages) {
  const bodies = [];
  const impl = async (url, init) => {
    bodies.push(JSON.parse(new URLSearchParams(init.body).get('f.req')));
    const json = pages[bodies.length - 1];
    return { ok: true, status: 200, text: async () => JSON.stringify(json) };
  };
  return { impl, bodies };
}

async function scan() {
  const { impl } = fakeFetch([page1, page2]);
  return searchDomain({ domain: 'directmeds.com', region: 'US', fetchImpl: impl });
}

test('request filters by domain and US region', () => {
  const r = buildSearchRequest({ domain: 'directmeds.com', region: 'US', pageToken: 'T' });
  assert.deepEqual(r[3][12], { 1: 'directmeds.com', 2: true });
  assert.deepEqual(r[3][8], [2840]);
  assert.equal(r[4], 'T');
  assert.equal(buildSearchRequest({ domain: 'x.com', region: 'anywhere' })[3][8], undefined);
});

test('pages through every result using the next-page token', async () => {
  const { impl, bodies } = fakeFetch([page1, page2]);
  const { creatives, truncated } = await searchDomain({ domain: 'directmeds.com', region: 'US', fetchImpl: impl });
  assert.equal(creatives.length, 5);
  assert.equal(truncated, false);
  assert.equal(bodies[1][4], 'PAGE2TOKEN');
});

test('a cap that cuts the list short is reported, not hidden', async () => {
  const { impl } = fakeFetch([page1, page2]);
  const r = await searchDomain({ domain: 'directmeds.com', region: 'US', max: 2, fetchImpl: impl });
  assert.equal(r.creatives.length, 2);
  assert.equal(r.truncated, true);
});

test('parses the creative fields', () => {
  const [c] = parseSearchResponse(page1).creatives;
  assert.equal(c.advertiserName, 'Direct Meds LLC');
  assert.equal(c.format, 'text');
  assert.equal(c.lastShown.slice(0, 10), '2025-10-19');
  assert.match(c.url, /advertiser\/AR0+1\/creative\/CR0+11\?region=US$/);
});

test('empty object means no ads; a changed shape throws instead of reading as zero', () => {
  assert.deepEqual(parseSearchResponse({}).creatives, []);
  assert.throws(() => parseSearchResponse([]), /Unexpected/);
  assert.throws(() => parseSearchResponse({ 1: 'nope' }), /Unexpected/);
  assert.throws(() => parseSearchResponse({ 1: [{ a: 1 }] }), /no longer carry/);
});

test('official account by name; everyone else is flagged; stale advertisers excluded', async () => {
  const { creatives } = await scan();
  const r = buildReport({ target, creatives, prevState: null, now: NOW, activeWithinDays: 7 });
  assert.equal(r.totalAdvertisers, 3);
  assert.deepEqual(r.official.map((a) => a.advertiserName), ['Direct Meds LLC']);
  assert.deepEqual(r.unofficial.map((a) => a.advertiserId).sort(), ['AR00000000000000000002', 'AR00000000000000000004']);
  assert.equal(r.officialNameMatchedOnly.length, 1);
  assert.equal(r.firstRun, true);
});

test('name matching ignores case and punctuation, ID pin overrides name', () => {
  assert.equal(normaliseName('Direct Meds, LLC.'), normaliseName('DIRECT MEDS LLC'));
  const pinned = { ...target, officialAdvertiserNames: [], officialAdvertiserIds: ['AR00000000000000000001'] };
  const creatives = parseSearchResponse(page1).creatives;
  const r = buildReport({ target: pinned, creatives, prevState: null, now: NOW });
  assert.equal(r.official[0].advertiserId, 'AR00000000000000000001');
  assert.equal(r.officialNameMatchedOnly.length, 0);
});

test('second run: known advertisers are not new, but their new ads are', async () => {
  const { creatives } = await scan();
  const state = nextState(null, creatives.filter((c) => c.creativeId !== 'CR00000000000000000022'), NOW - 86400000);
  const r = buildReport({ target, creatives, prevState: state, now: NOW });
  assert.equal(r.newUnofficial.length, 0);
  assert.equal(r.returningWithNewAds.length, 1);
  assert.equal(r.returningWithNewAds[0].newCreatives[0].creativeId, 'CR00000000000000000022');
});

test('summary names every unauthorized advertiser and escapes Slack markup', async () => {
  const { creatives } = await scan();
  const r = buildReport({ target, creatives, prevState: null, now: NOW });
  const msg = summaryMessage(r, { region: 'US', truncated: false });
  assert.match(msg, /2 NEW unauthorized advertisers/);
  assert.match(msg, /Rx Savings Partners Inc/);
  assert.match(msg, /Meds Deals &lt;Co&gt; \/ Ltd/);
  assert.match(msg, /1 official, \*2 not authorized\*/);
  assert.match(msg, /Pin `AR00000000000000000001`/);
  assert.doesNotMatch(msg, /Old Affiliate/);
});

test('clean day posts an all-clear', () => {
  const creatives = parseSearchResponse(page1).creatives.slice(0, 1);
  const r = buildReport({ target, creatives, prevState: null, now: NOW });
  assert.match(summaryMessage(r, { region: 'US' }), /no unauthorized advertisers/);
});

test('captures prefer text ads and respect both caps', async () => {
  const { creatives } = await scan();
  const r = buildReport({ target, creatives, prevState: null, now: NOW });
  const picks = pickCaptures(r, 1, 10);
  assert.equal(picks.length, 2);
  assert.ok(picks.every((p) => p.creative.format === 'text'));
  assert.equal(pickCaptures(r, 3, 1).length, 1);
});

test('reply carries ad copy, or the render failure', () => {
  const [c] = parseSearchResponse(page1).creatives;
  const a = { advertiserName: 'X', advertiserId: c.advertiserId };
  assert.match(creativeReply(a, c, { ok: true, adText: 'DirectMeds Official <Site>' }), />>> DirectMeds Official &lt;Site&gt;/);
  assert.match(creativeReply(a, c, { ok: false, error: 'timeout' }), /Could not render this ad: timeout/);
  assert.equal(esc('a&b'), 'a&amp;b');
});

test('ad text cleaner drops page chrome and duplicates', () => {
  const t = cleanAdText(['Sponsored\nDirectMeds® Official Site\nDirectMeds® Official Site\nSee all ads', 'Last shown']);
  assert.equal(t, 'Sponsored\nDirectMeds® Official Site');
});
