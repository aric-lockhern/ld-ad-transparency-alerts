// Diagnostic: asks DataForSEO's Google Ads Search (Ads Transparency Center
// data) for every ad pointing at a domain and prints what comes back — totals,
// advertisers, the raw shape of one item — so it can be compared with the 17
// ads an anonymous Transparency Center visit returns. Posts nothing anywhere.
//
//   DATAFORSEO_LOGIN=… DATAFORSEO_PASSWORD=… node scripts/probe-dataforseo.mjs directmeds.com
//
// Uses the queued task flow (task_post, then task_get/advanced), which is
// cheaper than live. Logs DataForSEO's own status codes and messages verbatim,
// because a wrong parameter is reported there rather than as an HTTP error.

const domain = (process.argv[2] || 'directmeds.com').toLowerCase();
const login = process.env.DATAFORSEO_LOGIN;
const password = process.env.DATAFORSEO_PASSWORD;
if (!login || !password) {
  console.log('DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set; skipping the DataForSEO check.');
  process.exit(0);
}

const API = 'https://api.dataforseo.com/v3/serp/google/ads_search';
const auth = 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status}, not JSON: ${text.slice(0, 300)}`); }
  console.log(`${method} ${path} -> HTTP ${res.status}, status ${json.status_code} "${json.status_message}", cost ${json.cost}`);
  return json;
}

const task = { target: domain, location_code: 2840, depth: 700 };
console.log(`Request: ${JSON.stringify(task)}`);
const posted = await call('POST', '/task_post', [task]);
const t = posted.tasks && posted.tasks[0];
if (!t || !t.id || (t.status_code && t.status_code >= 40000)) {
  console.log(`Task refused: ${t ? `${t.status_code} "${t.status_message}"` : 'no task returned'}`);
  process.exit(1);
}
console.log(`Task ${t.id}: ${t.status_code} "${t.status_message}"`);

// Queued tasks usually finish within a minute or two.
let result = null;
for (let i = 0; i < 40 && !result; i++) {
  await new Promise((r) => setTimeout(r, 15000));
  const got = await call('GET', `/task_get/advanced/${t.id}`);
  const g = got.tasks && got.tasks[0];
  if (!g) continue;
  if (g.status_code === 20000 && g.result) result = g.result[0];
  else if (g.status_code >= 40000 && g.status_code !== 40601 && g.status_code !== 40602) {
    console.log(`Task failed: ${g.status_code} "${g.status_message}"`);
    process.exit(1);
  } else console.log(`  waiting: ${g.status_code} "${g.status_message}"`);
}
if (!result) {
  console.log('No result after 10 minutes.');
  process.exit(1);
}

const items = result.items || [];
const { items: _omit, ...meta } = result;
console.log(`\nResult fields other than items: ${JSON.stringify(meta).slice(0, 1500)}`);
console.log(`Items returned: ${items.length}`);
if (items[0]) console.log(`First item, raw: ${JSON.stringify(items[0]).slice(0, 1500)}`);

const by = {};
for (const it of items) {
  const name = it.title || it.advertiser_name || it.advertiser || it.advertiser_id || '(unknown)';
  const a = (by[name] = by[name] || { ads: 0, last: '' });
  a.ads++;
  const last = String(it.last_shown || '');
  if (last > a.last) a.last = last;
}
console.log('\nAdvertisers (name | ads | latest last_shown):');
for (const [name, a] of Object.entries(by).sort((x, y) => y[1].ads - x[1].ads)) {
  console.log(`  ${name} | ${a.ads} | ${a.last.slice(0, 19)}`);
}
console.log(`\nCompare: an anonymous Transparency Center visit returned 17 ads from 4 advertisers.`);
