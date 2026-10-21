// Google Ads Transparency Center client.
//
// There is no public API. The Transparency Center page talks to an internal
// RPC (SearchService/SearchCreatives) with protobuf-style JSON. The request
// format is NOT hand-built here: the first version did that, and Google
// answered a different question — 17 ads from an unrelated agency where its
// own page showed ~2K for the domain. Instead the scan opens the real page,
// captures the exact request that page sends, and pages onward by replaying
// it with the next-page token. Whatever Google changes, the page keeps working,
// so this keeps working.
//
// Two guards keep a broken scan from reading as a clean one: a response with an
// unexpected shape throws, and so does a scan that collected far fewer ads than
// the count Google prints on its own page.

const SITE = 'https://adstransparency.google.com';

// Geo criterion IDs used by the Transparency Center's region filter.
export const REGIONS = { US: 2840, CA: 2124, GB: 2826, AU: 2036 };

export function regionId(region) {
  if (region === 'anywhere' || region == null) return null;
  const id = REGIONS[String(region).toUpperCase()];
  if (!id) throw new Error(`Unknown region "${region}". Known: ${Object.keys(REGIONS).join(', ')}, anywhere`);
  return id;
}

function toDate(secs) {
  const n = Number(secs);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}

const FORMATS = { 1: 'text', 2: 'image', 3: 'video' };

export function parseCreative(raw) {
  const advertiserId = raw[1];
  const creativeId = raw[2];
  if (typeof advertiserId !== 'string' || typeof creativeId !== 'string') return null;
  const preview = raw[3] || {};
  return {
    advertiserId,
    creativeId,
    advertiserName: raw[12] || '(unnamed advertiser)',
    format: FORMATS[raw[4]] || 'unknown',
    firstShown: toDate(raw[6] && raw[6][1]),
    lastShown: toDate(raw[7] && raw[7][1]),
    domain: raw[14] || null,
    previewUrl: (preview[1] && preview[1][4]) || null,
    previewHtml: (preview[3] && preview[3][2]) || null,
    url: creativeUrl(advertiserId, creativeId),
  };
}

export function parseSearchResponse(json) {
  if (json == null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(`Unexpected Transparency Center response: ${JSON.stringify(json).slice(0, 300)}`);
  }
  // An empty object is Google's answer for "no ads for this site".
  const rows = json[1] || [];
  if (!Array.isArray(rows)) {
    throw new Error(`Unexpected Transparency Center response shape: ${JSON.stringify(json).slice(0, 300)}`);
  }
  const creatives = rows.map(parseCreative);
  if (rows.length && creatives.every((c) => c === null)) {
    throw new Error(`Transparency Center rows no longer carry advertiser/creative IDs: ${JSON.stringify(rows[0]).slice(0, 300)}`);
  }
  return { creatives: creatives.filter(Boolean), nextPageToken: json[2] || null };
}

export function creativeUrl(advertiserId, creativeId, region = 'US') {
  const r = region && region !== 'anywhere' ? `?region=${region}` : '';
  return `${SITE}/advertiser/${advertiserId}/creative/${creativeId}${r}`;
}

export function domainUrl(domain, region = 'US') {
  const r = region && region !== 'anywhere' ? `&region=${region}` : '';
  return `${SITE}/?domain=${encodeURIComponent(domain)}${r}`;
}

const RPC_PATH = 'SearchService/SearchCreatives';

export function parseJsonText(text) {
  // Google sometimes prefixes JSON with an anti-XSSI guard line.
  const clean = String(text).replace(/^\)\]\}'[^\n]*\n/, '');
  try {
    return JSON.parse(clean);
  } catch {
    throw new Error(`Transparency Center returned non-JSON: ${clean.slice(0, 300)}`);
  }
}

// "~2K ads", "1,234 ads", "~1.5M ads" -> a number; null when not found.
export function parseShownCount(text) {
  const m = /(~)?\s*([\d.,]+)\s*([KM])?\s+ads\b/i.exec(String(text || ''));
  if (!m) return null;
  let n = Number(m[2].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  if (m[3]) n *= m[3].toUpperCase() === 'K' ? 1000 : 1000000;
  return Math.round(n);
}

// Google rounds ("~2K" is anything from about 1,500 to 2,499), so only a
// collection under half the printed count is treated as broken.
export function assertComplete({ collected, shown, truncated, domain }) {
  if (truncated || shown == null) return;
  if (collected < shown * 0.5) {
    throw new Error(
      `Google's page shows about ${shown.toLocaleString('en-US')} ads for ${domain}, but the scan only read ${collected}. ` +
        `The Transparency Center has probably changed; nothing was reported.`,
    );
  }
}

// Which key of a request body carries the next-page token: the one whose value
// in the page's own second request equals the token its first response gave.
export function findTokenKey(firstJson, secondBody) {
  const token = firstJson && firstJson[2];
  if (!token || !secondBody) return null;
  for (const [k, v] of Object.entries(secondBody)) if (v === token) return k;
  return null;
}

// Pages from a captured first request/response. `fetchPage(body)` sends one
// request body and resolves to the parsed JSON. Pure apart from that, so the
// paging logic is tested without a browser.
export async function collectPages({ firstBody, firstJson, fetchPage, max, tokenKey = '4' }) {
  const all = [];
  const seen = new Set();
  const add = (creatives) => {
    let fresh = 0;
    for (const c of creatives) {
      if (seen.has(c.creativeId)) continue;
      seen.add(c.creativeId);
      all.push(c);
      fresh++;
    }
    return fresh;
  };
  let page = parseSearchResponse(firstJson);
  add(page.creatives);
  let pages = 1;
  while (page.nextPageToken && all.length < max) {
    if (++pages > 500) throw new Error('Transparency Center kept returning more pages; stopped after 500.');
    page = parseSearchResponse(await fetchPage({ ...firstBody, [tokenKey]: page.nextPageToken }));
    // A page of nothing new means the token is not being honoured and the
    // same results are coming back. Stop loudly rather than loop or under-count.
    if (page.creatives.length && !add(page.creatives)) {
      throw new Error(`Transparency Center paging is not advancing (page ${pages} repeated earlier results).`);
    }
  }
  return { creatives: all.slice(0, max), truncated: Boolean(page.nextPageToken) };
}

export function searchPageUrl(domain, region) {
  const r = region && region !== 'anywhere' ? String(region).toUpperCase() : 'anywhere';
  return `${SITE}/?region=${r}&domain=${encodeURIComponent(domain)}`;
}

// Every creative Google lists for ads pointing at `domain`, read the way the
// Transparency Center page itself reads them. `context` is a Playwright
// browser context. `requestBody` is returned so the log shows exactly what was
// asked, for the day Google changes something.
export async function searchDomain({ context, domain, region, max = 5000 }) {
  const page = await context.newPage();
  try {
    const captured = [];
    page.on('response', async (res) => {
      const req = res.request();
      if (!req.url().includes(RPC_PATH) || req.method() !== 'POST') return;
      try {
        const form = new URLSearchParams(req.postData() || '');
        const body = JSON.parse(form.get('f.req') || 'null');
        captured.push({ url: req.url(), headers: req.headers(), body, json: parseJsonText(await res.text()) });
      } catch {
        // Not a request we can replay; ignore it.
      }
    });

    await page.goto(searchPageUrl(domain, region), { waitUntil: 'domcontentloaded', timeout: 60000 });
    const forDomain = () => captured.filter((c) => JSON.stringify(c.body).includes(domain));
    const deadline = Date.now() + 45000;
    while (!forDomain().length && Date.now() < deadline) await page.waitForTimeout(500);
    const first = forDomain()[0];
    if (!first) {
      throw new Error(
        `The Transparency Center page for ${domain} never sent a search for it ` +
          `(saw ${captured.length} other search request(s)). The page has probably changed.`,
      );
    }

    // Let the count render, then read it the way a person would.
    await page.waitForFunction(() => /\bads\b/i.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
    const shown = parseShownCount(await page.evaluate(() => document.body.innerText));

    // Scroll once so the page asks for page two itself, which shows which
    // field carries the next-page token instead of assuming one.
    let tokenKey = null;
    if (first.json && first.json[2]) {
      for (let i = 0; i < 12 && !tokenKey; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.getByRole('button', { name: /see all|show more|load more|more ads/i }).first().click({ timeout: 1000 }).catch(() => {});
        await page.waitForTimeout(1000);
        for (const c of forDomain().slice(1)) tokenKey = tokenKey || findTokenKey(first.json, c.body);
      }
    }

    const headers = { ...first.headers, 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' };
    delete headers['content-length'];
    const fetchPage = async (body) => {
      for (let attempt = 1; ; attempt++) {
        const res = await page.request.post(first.url, {
          headers,
          data: new URLSearchParams({ 'f.req': JSON.stringify(body) }).toString(),
        });
        if ((res.status() === 429 || res.status() >= 500) && attempt < 4) {
          await page.waitForTimeout(2000 * 2 ** attempt);
          continue;
        }
        const text = await res.text();
        if (!res.ok()) throw new Error(`Transparency Center HTTP ${res.status()}: ${text.slice(0, 300)}`);
        return parseJsonText(text);
      }
    };

    const out = await collectPages({ firstBody: first.body, firstJson: first.json, fetchPage, max, tokenKey: tokenKey || '4' });
    assertComplete({ collected: out.creatives.length, shown, truncated: out.truncated, domain });
    return { ...out, shown, tokenKey: tokenKey || '4 (assumed)', requestBody: first.body };
  } finally {
    await page.close().catch(() => {});
  }
}
