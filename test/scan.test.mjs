import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseSearchResponse, collectPages, findTokenKey, parseShownCount, assertComplete, parseJsonText, searchPageUrl,
} from '../src/transparency.mjs';
import { buildReport, nextState, normaliseName } from '../src/classify.mjs';
import { summaryMessage, creativeReply, esc } from '../src/slack.mjs';
import { pickCaptures } from '../src/run.mjs';
import { cleanAdText } from '../src/capture.mjs';

const page1 = JSON.parse(readFileSync(new URL('./fixtures/search-page1.json', import.meta.url)));
const page2 = JSON.parse(readFileSync(new URL('./fixtures/search-page2.json', import.meta.url)));
const NOW = 1761000000 * 1000;
const target = { domain: 'directmeds.com', officialAdvertiserNames: ['Direct Meds LLC'], officialAdvertiserIds: [] };

// Stands in for the request the Transparency Center page sends; its exact
// shape is Google's business, the scan only replays it.
const FIRST_BODY = { 2: 40, 3: { 12: { 1: 'directmeds.com', 2: true } }, 7: { 1: 1 } };

function pager(pages) {
  const bodies = [];
  const fetchPage = async (body) => {
    bodies.push(body);
    return pages[bodies.length];
  };
  return { fetchPage, bodies };
}

async function scan() {
  const { fetchPage } = pager([page1, page2]);
  return collectPages({ firstBody: FIRST_BODY, firstJson: page1, fetchPage, max: 5000 });
}

test('search opens the same page a person would', () => {
  assert.equal(searchPageUrl('directmeds.com', 'US'), 'https://adstransparency.google.com/?region=US&domain=directmeds.com');
  assert.equal(searchPageUrl('x.com', 'anywhere'), 'https://adstransparency.google.com/?region=anywhere&domain=x.com');
});

test('pages by replaying the page\'s own request with the learned token field', async () => {
  const { fetchPage, bodies } = pager([page1, page2]);
  const { creatives, truncated } = await collectPages({ firstBody: FIRST_BODY, firstJson: page1, fetchPage, max: 5000, tokenKey: '9' });
  assert.equal(creatives.length, 5);
  assert.equal(truncated, false);
  assert.equal(bodies[0][9], 'PAGE2TOKEN');
  assert.deepEqual(bodies[0][3], FIRST_BODY[3], 'the rest of the request is untouched');
});

test('the token field is read off the page\'s own second request', () => {
  assert.equal(findTokenKey(page1, { 2: 40, 3: {}, 9: 'PAGE2TOKEN' }), '9');
  assert.equal(findTokenKey(page1, { 2: 40 }), null);
  assert.equal(findTokenKey({}, { 4: 'x' }), null);
});

test('paging that repeats itself fails instead of looping or under-counting', async () => {
  const { fetchPage } = pager([page1, page1]);
  await assert.rejects(
    collectPages({ firstBody: FIRST_BODY, firstJson: page1, fetchPage, max: 5000 }),
    /paging is not advancing/,
  );
});

test('a cap that cuts the list short is reported, not hidden', async () => {
  const { fetchPage } = pager([page1, page2]);
  const r = await collectPages({ firstBody: FIRST_BODY, firstJson: page1, fetchPage, max: 2 });
  assert.equal(r.creatives.length, 2);
  assert.equal(r.truncated, true);
});

test('reads Google\'s printed ad count', () => {
  assert.equal(parseShownCount('directmeds.com\n~2K ads\nAny time'), 2000);
  assert.equal(parseShownCount('1,234 ads'), 1234);
  assert.equal(parseShownCount('~1.5K ads'), 1500);
  assert.equal(parseShownCount('Find the ads you have seen'), null);
});

test('a scan far short of Google\'s own count fails loudly (the 17-of-~2K bug)', () => {
  assert.throws(() => assertComplete({ collected: 17, shown: 2000, truncated: false, domain: 'directmeds.com' }), /only read 17/);
  assert.doesNotThrow(() => assertComplete({ collected: 1600, shown: 2000, truncated: false, domain: 'd' }));
  assert.doesNotThrow(() => assertComplete({ collected: 17, shown: 2000, truncated: true, domain: 'd' }));
  assert.doesNotThrow(() => assertComplete({ collected: 17, shown: null, truncated: false, domain: 'd' }));
});

test('strips Google\'s anti-XSSI prefix', () => {
  assert.deepEqual(parseJsonText(")]}'\n{\"1\":[]}"), { 1: [] });
  assert.throws(() => parseJsonText('<html>'), /non-JSON/);
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

test('ad text cleaner drops rendering script (seen in the first live run)', () => {
  const junk = "Buscaempleo hoy(function() {const head = document.head;const body = document.getElementById('mys-content');})();";
  const t = cleanAdText(['#1 Korean Eye Balm - 50% off Today\nAd •\n' + junk]);
  assert.equal(t, '#1 Korean Eye Balm - 50% off Today\nAd •');
});

test('ad text cleaner drops page chrome and duplicates', () => {
  const t = cleanAdText(['Sponsored\nDirectMeds® Official Site\nDirectMeds® Official Site\nSee all ads', 'Last shown']);
  assert.equal(t, 'Sponsored\nDirectMeds® Official Site');
});

test('a 1-day window lists only today\'s advertisers and says "today"', async () => {
  const { creatives } = await scan();
  // NOW is 1761000000; Rx Savings last shown 1760990000 (~3 h before), Direct Meds 1760900000 (~28 h before).
  const r = buildReport({ target, creatives, prevState: null, now: NOW, activeWithinDays: 1 });
  assert.deepEqual(r.unofficial.map((a) => a.advertiserName).sort(), ['Meds Deals <Co> | Ltd', 'Rx Savings Partners Inc']);
  assert.equal(r.official.length, 0, 'the official account last ran 28 hours ago');
  const msg = summaryMessage(r, { region: 'US', truncated: false });
  assert.match(msg, /directmeds\.com> today \(last 24 hours\)/);
  assert.doesNotMatch(msg, /Old Affiliate|Direct Meds LLC/);
});
