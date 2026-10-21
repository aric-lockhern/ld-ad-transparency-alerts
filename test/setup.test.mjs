import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateConfig, cleanDomain } from '../src/config.mjs';
import { handle, GitHub, pinOk } from '../netlify/lib/admin.mjs';
import { resultSummary, channelFor } from '../src/run.mjs';
import { parseSearchResponse } from '../src/transparency.mjs';
import { buildReport } from '../src/classify.mjs';

const committed = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
const good = {
  targets: [{ name: 'DirectMeds', domain: 'directmeds.com', officialAdvertiserNames: ['Direct Meds LLC'], slackChannelId: 'c0123abcdef' }],
};

test('the committed config.json is valid', () => {
  assert.deepEqual(validateConfig(committed).errors, []);
});

test('pasted URLs become domains; textarea lines become lists', () => {
  assert.equal(cleanDomain(' https://www.DirectMeds.com/shop?x=1 '), 'directmeds.com');
  const { config, errors } = validateConfig({
    targets: [{ domain: 'directmeds.com', officialAdvertiserNames: 'Direct Meds LLC\n\nDirect Meds LLC\nOther', officialAdvertiserIds: '' }],
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(config.targets[0].officialAdvertiserNames, ['Direct Meds LLC', 'Other']);
  assert.equal(config.targets[0].name, 'directmeds.com');
  assert.equal(config.targets[0].enabled, true);
});

test('errors name the client and the field', () => {
  const { errors } = validateConfig({
    region: 'XX',
    targets: [
      { name: 'A', domain: 'not a domain', officialAdvertiserNames: ['x'] },
      { name: 'B', domain: 'b.com', officialAdvertiserNames: [], slackChannelId: '#general' },
      { name: 'C', domain: 'b.com', officialAdvertiserNames: ['y'], officialAdvertiserIds: ['123'] },
    ],
  });
  const all = errors.join('\n');
  assert.match(all, /Region "XX"/);
  assert.match(all, /A: "not a domain" is not a website domain/);
  assert.match(all, /B: add the official advertiser name/);
  assert.match(all, /B: "#GENERAL" is not a Slack channel ID/);
  assert.match(all, /C: b\.com is listed twice/);
  assert.match(all, /C: "123" is not an advertiser ID/);
});

test('channel ID is normalised to upper case; env fallback still works', () => {
  const t = validateConfig(good).config.targets[0];
  assert.equal(t.slackChannelId, 'C0123ABCDEF');
  assert.equal(channelFor({ slackChannelId: '', slackChannelEnv: 'X' }, { X: 'C999' }), 'C999');
});

test('PIN: unset refuses everyone; wrong or missing is refused', () => {
  assert.equal(pinOk('1234', ''), false);
  assert.equal(pinOk('', '1234'), false);
  assert.equal(pinOk('1235', '1234'), false);
  assert.equal(pinOk('1234', '1234'), true);
});

function fakeGitHub(files) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname.replace('/repos/o/r', '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path: p, body });
    const reply = (status, json) => ({ status, text: async () => (json == null ? '' : JSON.stringify(json)) });
    if (init.method === 'GET' && p.startsWith('/contents/')) {
      const f = files[p.slice(10)];
      if (!f) return reply(404, { message: 'Not Found' });
      return reply(200, { sha: f.sha, content: Buffer.from(JSON.stringify(f.data)).toString('base64') });
    }
    if (init.method === 'PUT') {
      const f = files[p.slice(10)];
      if (f && body.sha !== f.sha) return reply(409, { message: 'sha mismatch' });
      files[p.slice(10)] = { sha: 'new' + Date.now(), data: JSON.parse(Buffer.from(body.content, 'base64').toString()) };
      return reply(200, { content: { sha: files[p.slice(10)].sha } });
    }
    if (p.endsWith('/dispatches')) return reply(204, null);
    if (p.endsWith('/runs')) return reply(200, { workflow_runs: [{ id: 1, display_title: 'dry-run · directmeds.com', status: 'in_progress', html_url: 'u' }] });
    return reply(500, { message: 'unexpected' });
  };
  return { gh: new GitHub({ token: 't', repo: 'o/r', branch: 'main', fetchImpl }), calls, files };
}

test('load returns config, each client\'s latest result, and runs', async () => {
  const { gh } = fakeGitHub({
    'config.json': { sha: 's1', data: good },
    'results/directmeds.com.json': { sha: 'r', data: { ok: true, totalAdvertisers: 4 } },
  });
  const out = await handle('load', {}, gh);
  assert.equal(out.sha, 's1');
  assert.equal(out.results['directmeds.com'].totalAdvertisers, 4);
  assert.equal(out.runs[0].title, 'dry-run · directmeds.com');
});

test('save validates before writing, and refuses a stale sha', async () => {
  const { gh, files } = fakeGitHub({ 'config.json': { sha: 's1', data: good } });
  const bad = await handle('save', { config: { targets: [{ domain: 'x' }] }, sha: 's1' }, gh);
  assert.equal(bad.status, 400);
  assert.equal(files['config.json'].sha, 's1');

  const ok = await handle('save', { config: good, sha: 's1' }, gh);
  assert.notEqual(ok.sha, 's1');
  assert.equal(files['config.json'].data.targets[0].slackChannelId, 'C0123ABCDEF');

  await assert.rejects(handle('save', { config: good, sha: 's1' }, gh), /Someone else saved/);
});

test('run dispatches the workflow with a known mode only', async () => {
  const { gh, calls } = fakeGitHub({});
  await handle('run', { mode: 'scan', target: 'DirectMeds.com' }, gh);
  await handle('run', { mode: 'rm -rf', target: '' }, gh);
  const d = calls.filter((c) => c.path.endsWith('/dispatches'));
  assert.deepEqual(d[0].body, { ref: 'main', inputs: { mode: 'scan', target: 'directmeds.com' } });
  assert.equal(d[1].body.inputs.mode, 'dry-run');
});

test('result summary is what the page needs to pin the official account', () => {
  const page1 = JSON.parse(readFileSync(new URL('./fixtures/search-page1.json', import.meta.url)));
  const creatives = parseSearchResponse(page1).creatives;
  const target = { domain: 'directmeds.com', officialAdvertiserNames: ['Direct Meds LLC'], officialAdvertiserIds: [] };
  const report = buildReport({ target, creatives, prevState: null, now: 1761000000000 });
  const s = resultSummary(report, { dryRun: true, truncated: false });
  assert.equal(s.totalAdvertisers, 2);
  assert.equal(s.unauthorized, 1);
  assert.deepEqual(s.advertisers.map((a) => [a.id, a.official]), [
    ['AR00000000000000000001', true],
    ['AR00000000000000000002', false],
  ]);
  assert.match(s.advertisers[1].url, /\/advertiser\/AR0+2\?region=US$/);
});

test('advertisers outside the window are kept and marked, never dropped (the 1-of-4 bug)', async () => {
  const page2 = JSON.parse(readFileSync(new URL('./fixtures/search-page2.json', import.meta.url)));
  const page1 = JSON.parse(readFileSync(new URL('./fixtures/search-page1.json', import.meta.url)));
  const creatives = [...parseSearchResponse(page1).creatives, ...parseSearchResponse(page2).creatives];
  const target = { domain: 'directmeds.com', officialAdvertiserNames: ['Direct Meds LLC'], officialAdvertiserIds: [] };
  const report = buildReport({ target, creatives, prevState: null, now: 1761000000000, activeWithinDays: 7 });
  const s = resultSummary(report, { dryRun: true, truncated: false });
  const old = s.advertisers.find((a) => a.name === 'Old Affiliate LLC');
  assert.ok(old, 'the stale advertiser is still listed');
  assert.equal(old.active, false);
  assert.equal(old.official, false);
  assert.equal(s.unauthorized, 2, 'but it is not counted as running now');
  assert.equal(s.totalAllTime, 5);
  assert.ok(s.advertisers.filter((a) => a.active).length === 3);
});
