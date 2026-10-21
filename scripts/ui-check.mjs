// Renders public/index.html in headless Chromium with /api/admin stubbed,
// walks the setup flow at desktop and phone widths, fails on any JS error,
// and writes screenshots to .uicheck/. Proves the page, not the backend.
//
//   npm run test:ui

import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const OUT = new URL('../.uicheck/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function backend() {
  const state = {
    sha: 's1',
    config: {
      region: 'US', activeWithinDays: 7, maxCreativesPerTarget: 2000, maxScreenshotsPerAdvertiser: 3,
      maxScreenshotsPerRun: 25, postWhenClean: true,
      targets: [{ name: 'DirectMeds', domain: 'directmeds.com', enabled: true, officialAdvertiserNames: ['Direct Meds LLC'], officialAdvertiserIds: [], slackChannelId: 'C0123ABCDEF' }],
    },
    results: {
      'directmeds.com': {
        ok: true, scannedAt: new Date(Date.now() - 3600e3).toISOString(), dryRun: true, truncated: false, activeWithinDays: 7,
        totalAdvertisers: 3, totalAds: 14, unauthorized: 2, newUnauthorized: 2,
        advertisers: [
          { id: 'AR11111111111111111111', name: 'Direct Meds LLC', official: true, isNew: true, ads: 9, newAds: 9, formats: ['text', 'image'], lastShown: '2026-10-21T00:00:00Z', url: 'https://adstransparency.google.com/advertiser/AR11111111111111111111?region=US' },
          { id: 'AR22222222222222222222', name: 'Rx Savings Partners Inc', official: false, isNew: true, ads: 4, newAds: 4, formats: ['text'], lastShown: '2026-10-20T00:00:00Z', url: 'https://adstransparency.google.com/advertiser/AR22222222222222222222?region=US' },
          { id: 'AR44444444444444444444', name: 'Sapphire Media Group LLC', official: false, isNew: false, ads: 4, newAds: 0, formats: ['video'], lastShown: '2026-06-01T00:00:00Z', url: 'https://adstransparency.google.com/advertiser/AR44444444444444444444?region=US', active: false },
          { id: 'AR33333333333333333333', name: 'A Very Long Affiliate Marketing Company Name Holdings International LLC', official: false, isNew: true, ads: 1, newAds: 1, formats: ['text'], lastShown: '2026-10-19T00:00:00Z', url: 'https://adstransparency.google.com/advertiser/AR33333333333333333333?region=US' },
        ],
      },
    },
    runs: [{ id: 1, title: 'Daily scan', status: 'completed', conclusion: 'success', createdAt: new Date(Date.now() - 86400e3).toISOString(), url: 'https://github.com' }],
    dispatched: [],
    saves: 0,
  };
  return state;
}

async function run(width, height, name) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/fonts\.g|Failed to load resource/.test(m.text()) && errors.push(m.text()));
  const S = backend();

  await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, body: '' }));
  await page.route('https://fonts.gstatic.com/**', (r) => r.fulfill({ status: 200, body: '' }));
  await page.route('http://ui.test/', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await page.route('http://ui.test/api/admin', async (r) => {
    const req = r.request();
    if (req.headers()['x-admin-pin'] !== '2468') return r.fulfill({ status: 401, body: JSON.stringify({ ok: false, error: 'pin' }) });
    const b = JSON.parse(req.postData());
    let out;
    if (b.action === 'load') out = { ok: true, config: S.config, sha: S.sha, results: S.results, runs: S.runs };
    else if (b.action === 'save') {
      if (b.sha !== S.sha) out = { ok: false, error: 'stale' };
      else if (b.config.targets.some((t) => !t.domain)) return r.fulfill({ status: 400, body: JSON.stringify({ ok: false, error: 'invalid', errors: ['New: "" is not a website domain (e.g. directmeds.com).'] }) });
      else {
        S.saves++;
        S.sha = 's' + (S.saves + 1);
        // the real backend returns validated lists; mimic that
        S.config = JSON.parse(JSON.stringify(b.config));
        S.config.targets.forEach((t) => {
          ['officialAdvertiserNames', 'officialAdvertiserIds'].forEach((k) => {
            if (typeof t[k] === 'string') t[k] = t[k].split('\n').map((s) => s.trim()).filter(Boolean);
          });
          t.domain = t.domain.trim().toLowerCase();
        });
        out = { ok: true, config: S.config, sha: S.sha };
      }
    } else if (b.action === 'run') {
      S.dispatched.push(b);
      S.runs.unshift({ id: 2, title: `${b.mode} · ${b.target}`, status: 'queued', conclusion: null, createdAt: new Date().toISOString(), url: 'https://github.com' });
      out = { ok: true, started: true };
    } else if (b.action === 'runs') out = { ok: true, runs: S.runs };
    else if (b.action === 'joinChannel') { S.joined = (S.joined || []).concat(b.channel); out = { ok: true, joined: true }; }
    else if (b.action === 'channels') out = { ok: true, channels: [
      { id: 'C0SHARED001', name: 'directmeds-lockhern', private: false, shared: true, member: true },
      { id: 'C0INTERN01', name: 'paid-search', private: false, shared: false, member: true },
      { id: 'C0NOTIN001', name: 'random', private: false, shared: false, member: false },
    ] };
    return r.fulfill({ status: out.ok === false ? 400 : 200, contentType: 'application/json', body: JSON.stringify(out) });
  });

  await page.goto('http://ui.test/');
  await page.fill('#pinInput', '1111');
  await page.click('#pinGo');
  await page.waitForSelector('#pinErr:not(.hidden)');
  assert.match(await page.textContent('#pinErr'), /Wrong PIN/);
  await page.fill('#pinInput', '2468');
  await page.press('#pinInput', 'Enter');
  await page.waitForSelector('.client');
  assert.match(await page.textContent('.client'), /2 not authorized/);
  assert.match(await page.textContent('.client'), /matched by name only/);
  assert.match(await page.textContent('.client'), /Sapphire Media Group LLC[\s\S]*Not running in the last 7 days/);
  await page.screenshot({ path: `${OUT}${name}-1-client.png`, fullPage: true });

  // Pin the official account from the table.
  await page.click('button[data-act="pin"][data-id="AR11111111111111111111"]');
  await page.waitForSelector('button[data-act="unpin"][data-id="AR11111111111111111111"]');
  assert.deepEqual(S.config.targets[0].officialAdvertiserIds, ['AR11111111111111111111']);
  assert.doesNotMatch(await page.textContent('.client'), /matched by name only/);

  // Start a test scan; the card shows it running and the button disables.
  await page.click('button[data-act="run"][data-mode="dry-run"]');
  await page.waitForSelector('.toast:not(.hidden)');
  assert.equal(S.dispatched[0].mode, 'dry-run');
  assert.equal(S.dispatched[0].target, 'directmeds.com');
  await page.waitForFunction(() => /test scan is running/.test(document.querySelector('.client').textContent), null, { timeout: 8000 });

  // Pick the Slack channel from the list rather than typing an ID.
  await page.click('.client button[data-act="edit"]');
  await page.waitForSelector('.chanPick select option[value="C0SHARED001"]', { state: 'attached' });
  // A channel the bot is not in is joined as soon as it is picked.
  await page.selectOption('.chanPick select', 'C0NOTIN001');
  await page.waitForFunction(() => /Bot added/.test(document.querySelector('.chanHint').textContent));
  assert.deepEqual(S.joined, ['C0NOTIN001']);
  await page.selectOption('.chanPick select', 'C0SHARED001');
  assert.match(await page.textContent('.chanHint'), /Shared with the client/);
  await page.screenshot({ path: `${OUT}${name}-1b-channel.png`, fullPage: true });
  await page.click('.client [data-form] button[data-act="saveClient"]');
  await page.waitForFunction(() => /Reports go to #directmeds-lockhern/.test(document.querySelector('.client').textContent));
  assert.equal(S.config.targets[0].slackChannelId, 'C0SHARED001');
  assert.equal(S.config.targets[0].slackChannelName, 'directmeds-lockhern');

  // Add a second client: blank domain is refused with the server's reason.
  await page.click('#addClient');
  await page.click('[data-form="new"] button[data-act="saveClient"]');
  await page.waitForSelector('[data-form="new"] .formErr:not(.hidden)');
  await page.fill('[data-form="new"] [name="name"]', 'Acme Pharmacy');
  await page.fill('[data-form="new"] [name="domain"]', 'acmepharmacy.com');
  await page.fill('[data-form="new"] [name="officialAdvertiserNames"]', 'Acme Pharmacy Inc');
  await page.screenshot({ path: `${OUT}${name}-2-add.png`, fullPage: true });
  await page.click('[data-form="new"] button[data-act="saveClient"]');
  await page.waitForFunction(() => document.querySelectorAll('.client').length === 2);
  const second = await page.locator('.client').nth(1).textContent();
  assert.match(second, /Never scanned/);
  assert.match(second, /No Slack channel yet/);
  assert.ok(await page.locator('.client').nth(1).locator('button[data-mode="scan"]').isDisabled());

  // No sideways scroll at any width.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px at ${width}px`);

  await page.screenshot({ path: `${OUT}${name}-3-two-clients.png`, fullPage: true });
  await browser.close();
  assert.deepEqual(errors, [], `JS errors at ${width}px`);
  console.log(`ok ${name} (${width}px)`);
}

await run(1280, 900, 'desktop');
await run(390, 844, 'phone');
