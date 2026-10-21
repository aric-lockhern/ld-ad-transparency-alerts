// Google Ads Transparency Center client.
//
// There is no public API. The Transparency Center web app talks to an internal
// RPC endpoint with protobuf-style JSON (numbered keys), and that is what this
// calls — the same request the page itself makes when you search a website.
// Google can change it without notice. When it does, parseSearchResponse
// throws with the raw shape rather than returning an empty list, because
// "zero advertisers found" and "the scanner broke" must never look the same.

const RPC_URL = 'https://adstransparency.google.com/anji/_/rpc/SearchService/SearchCreatives';
const SITE = 'https://adstransparency.google.com';

// Geo criterion IDs used by the Transparency Center's region filter.
export const REGIONS = { US: 2840, CA: 2124, GB: 2826, AU: 2036 };

export function regionId(region) {
  if (region === 'anywhere' || region == null) return null;
  const id = REGIONS[String(region).toUpperCase()];
  if (!id) throw new Error(`Unknown region "${region}". Known: ${Object.keys(REGIONS).join(', ')}, anywhere`);
  return id;
}

export function buildSearchRequest({ domain, region, pageSize = 100, pageToken }) {
  const geo = regionId(region);
  const filter = { 12: { 1: domain, 2: true } };
  if (geo) filter[8] = [geo];
  const req = { 2: pageSize, 3: filter, 7: geo ? { 1: 1, 2: 30, 3: geo } : { 1: 1 } };
  if (pageToken) req[4] = pageToken;
  return req;
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

async function post(body, fetchImpl, attempt = 1) {
  const res = await fetchImpl(`${RPC_URL}?authuser=`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      origin: SITE,
      referer: `${SITE}/`,
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
    },
    body: new URLSearchParams({ 'f.req': JSON.stringify(body) }).toString(),
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    return post(body, fetchImpl, attempt + 1);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Transparency Center HTTP ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Transparency Center returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
}

// Every creative Google lists for ads pointing at `domain`, paged to the end
// or to `max`. `truncated` says whether the cap was hit, so a report never
// presents a partial count as the whole picture.
export async function searchDomain({ domain, region, max = 2000, fetchImpl = fetch }) {
  const all = [];
  let pageToken = null;
  do {
    const json = await post(buildSearchRequest({ domain, region, pageToken }), fetchImpl);
    const page = parseSearchResponse(json);
    all.push(...page.creatives);
    pageToken = page.nextPageToken;
  } while (pageToken && all.length < max);
  return { creatives: all.slice(0, max), truncated: Boolean(pageToken) };
}
