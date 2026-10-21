// Diagnostic, not part of the daily scan. Opens the Transparency Center page
// for a domain the way the scan does, screenshots exactly what Google served,
// lists every search request the page sent, then replays that request with
// one thing changed at a time and prints how many ads and which advertisers
// each variant returns. Posts nothing anywhere.
//
//   node scripts/probe.mjs directmeds.com [region]

import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../src/capture.mjs';
import { parseJsonText, parseSearchResponse, parseShownCount, searchPageUrl } from '../src/transparency.mjs';

const domain = (process.argv[2] || 'directmeds.com').toLowerCase();
const region = process.argv[3] || 'US';
const OUT = 'out/probe';
await mkdir(OUT, { recursive: true });

function summarise(json) {
  try {
    const { creatives, nextPageToken } = parseSearchResponse(json);
    const by = {};
    for (const c of creatives) by[c.advertiserName] = (by[c.advertiserName] || 0) + 1;
    const topKeys = Object.keys(json || {}).join(',');
    return `${creatives.length} ads on page 1, more pages: ${Boolean(nextPageToken)}, response keys: [${topKeys}], advertisers: ${JSON.stringify(by)}`;
  } catch (e) {
    return `unparseable: ${e.message}`;
  }
}

const { browser, context, signedIn } = await openBrowser();
console.log(`Session: ${signedIn ? 'signed in (GOOGLE_COOKIES)' : 'anonymous'}`);
try {
  const page = await context.newPage();
  const captured = [];
  page.on('response', async (res) => {
    const req = res.request();
    if (!req.url().includes('/rpc/') || req.method() !== 'POST') return;
    let body = null;
    try { body = JSON.parse(new URLSearchParams(req.postData() || '').get('f.req') || 'null'); } catch {}
    let json = null;
    try { json = parseJsonText(await res.text()); } catch {}
    captured.push({ url: req.url(), headers: req.headers(), body, json });
  });

  const url = searchPageUrl(domain, region);
  console.log(`Opening ${url}`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch((e) => console.log(`goto: ${e.message}`));
  await page.waitForTimeout(4000);
  const text = await page.evaluate(() => document.body.innerText);
  console.log(`\nPrinted count: ${parseShownCount(text)}`);
  console.log(`Page text (first 1500 chars):\n${text.slice(0, 1500)}\n`);
  await page.screenshot({ path: `${OUT}/page.png`, fullPage: true });
  console.log(`Cookies: ${(await context.cookies()).map((c) => c.name).join(', ') || 'none'}`);
  try {
    const ip = await page.request.get('https://api.ipify.org?format=json');
    console.log(`Runner public IP: ${await ip.text()}`);
  } catch {}

  // Click "See all ads" the way a person does (it may be a link, a button or
  // plain text), then scroll whatever it opens and record what changes.
  const before = captured.length;
  const seeAll = page.getByText(/^\s*see all ads\s*$/i).first();
  if (await seeAll.count()) {
    console.log(`\nClicking "See all ads" (tag: ${await seeAll.evaluate((n) => n.tagName)})`);
    await seeAll.click({ timeout: 5000 }).catch((e) => console.log(`click failed: ${e.message.split('\n')[0]}`));
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(3000);
    console.log(`URL after click: ${page.url()}`);
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
    }
    const after = await page.evaluate(() => document.body.innerText);
    console.log(`Printed count after click: ${parseShownCount(after)}`);
    console.log(`Page text after click (first 800 chars):\n${after.slice(0, 800)}\n`);
    await page.screenshot({ path: `${OUT}/after-see-all.png`, fullPage: true });
    console.log(`Requests sent after the click: ${captured.length - before}`);
  } else {
    console.log('\nNo "See all ads" control found on the page.');
  }

  console.log(`\nRPC requests the page sent (${captured.length}):`);
  for (const c of captured) {
    const totals = c.json && !Array.isArray(c.json) ? ` totals 4=${JSON.stringify(c.json[4])} 5=${JSON.stringify(c.json[5])}` : '';
    console.log(`- ${c.url.replace(/\?.*/, '')}\n    body: ${JSON.stringify(c.body)}\n    -> ${summarise(c.json)}${totals}`);
  }
  const sample = captured.find((c) => c.url.includes('SearchCreatives') && c.json && Array.isArray(c.json[1]));
  if (sample) {
    console.log(`\nTop-level fields other than the ad list: ${JSON.stringify({ ...sample.json, 1: undefined })}`);
    console.log('Every ad in the response (advertiser | format | first shown | last shown | raw keys):');
    for (const raw of sample.json[1]) {
      const c = parseSearchResponse({ 1: [raw] }).creatives[0];
      console.log(`  ${c.advertiserName} | ${c.format} | ${c.firstShown} | ${c.lastShown} | keys ${Object.keys(raw).join(',')} | 6=${JSON.stringify(raw[6])} 7=${JSON.stringify(raw[7])}`);
    }
  }
  await writeFile(`${OUT}/captured.json`, JSON.stringify(captured.map(({ headers, ...rest }) => rest), null, 2));

  const first = captured.find((c) => c.url.includes('SearchCreatives') && JSON.stringify(c.body).includes(domain));
  if (!first) {
    console.log('\nNo SearchCreatives request for the domain; nothing to vary.');
  } else {
    const headers = { ...first.headers, 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' };
    delete headers['content-length'];
    const send = async (body) => {
      const r = await page.request.post(first.url, { headers, data: new URLSearchParams({ 'f.req': JSON.stringify(body) }).toString() });
      const t = await r.text();
      if (!r.ok()) return `HTTP ${r.status()}: ${t.slice(0, 200)}`;
      try {
        const j = parseJsonText(t);
        return `${summarise(j)} totals 4=${JSON.stringify(j[4])} 5=${JSON.stringify(j[5])}`;
      } catch (e) { return e.message; }
    };
    const clone = () => JSON.parse(JSON.stringify(first.body));
    const filter = (b) => b[3] || {};
    const domainKey = (b) => Object.keys(filter(b)).find((k) => JSON.stringify(filter(b)[k]).includes(domain));

    const variants = [
      ['as the page sent it', (b) => b],
      ['flag "2" false', (b) => { const k = domainKey(b); if (k && filter(b)[k]) filter(b)[k][2] = false; return b; }],
      ['flag "2" removed', (b) => { const k = domainKey(b); if (k && filter(b)[k]) delete filter(b)[k][2]; return b; }],
      ['www. prefix', (b) => { const k = domainKey(b); if (k && filter(b)[k]) filter(b)[k][1] = `www.${domain}`; return b; }],
      ['www. prefix, flag false', (b) => { const k = domainKey(b); if (k && filter(b)[k]) { filter(b)[k][1] = `www.${domain}`; filter(b)[k][2] = false; } return b; }],
      ['no region filter', (b) => { delete filter(b)[8]; if (b[7]) { delete b[7][3]; } return b; }],
      ['page size 100', (b) => { b[2] = 100; return b; }],
      // Seen in a signed-in browser that shows ~2K ads where anonymous shows 17.
      ['7.2 = 38 (signed-in browser value)', (b) => { b[7] = { ...(b[7] || {}), 2: 38 }; return b; }],
      ['7.2 = 38, page size 20 (signed-in body exactly)', (b) => { b[2] = 20; b[7] = { ...(b[7] || {}), 2: 38 }; return b; }],
      ['7.2 = 1', (b) => { b[7] = { ...(b[7] || {}), 2: 1 }; return b; }],
      ['7.2 removed', (b) => { if (b[7]) delete b[7][2]; return b; }],
    ];
    console.log('\nVariants (one change each):');
    for (const [name, fn] of variants) {
      const body = fn(clone());
      console.log(`- ${name}\n    body: ${JSON.stringify(body)}\n    -> ${await send(body)}`);
    }
  }
} finally {
  await browser.close();
}
