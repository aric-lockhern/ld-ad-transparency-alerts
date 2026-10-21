// Turns a flat list of creatives into the report: who is official, who is not,
// and what is new since the last run.

// "Direct Meds, LLC." and "DIRECT MEDS LLC" are the same verified name.
export function normaliseName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// An ID match is exact and preferred. A name match is the bootstrap: the
// first report prints the official account's ID so it can be pinned in
// config.json, after which a look-alike name cannot pass as official.
export function isOfficial(advertiser, target) {
  if ((target.officialAdvertiserIds || []).includes(advertiser.advertiserId)) return true;
  const names = (target.officialAdvertiserNames || []).map(normaliseName);
  return names.includes(normaliseName(advertiser.advertiserName));
}

export function isActive(creative, now, days) {
  // No last-shown date means we cannot rule it out, so it counts.
  if (!creative.lastShown) return true;
  return now - Date.parse(creative.lastShown) <= days * 86400000;
}

export function groupByAdvertiser(creatives) {
  const map = new Map();
  for (const c of creatives) {
    let a = map.get(c.advertiserId);
    if (!a) {
      a = { advertiserId: c.advertiserId, advertiserName: c.advertiserName, creatives: [] };
      map.set(c.advertiserId, a);
    }
    a.creatives.push(c);
  }
  for (const a of map.values()) {
    a.creatives.sort((x, y) => String(y.lastShown).localeCompare(String(x.lastShown)));
    a.lastShown = a.creatives[0].lastShown;
    a.firstShown = a.creatives.map((c) => c.firstShown).filter(Boolean).sort()[0] || null;
  }
  return [...map.values()];
}

// prevState: { advertisers: { [id]: { name, firstSeen, creatives: [ids] } } }
export function buildReport({ target, creatives, prevState, now = Date.now(), activeWithinDays = 7 }) {
  const prev = (prevState && prevState.advertisers) || {};
  const firstRun = !prevState || !prevState.lastRun;
  const active = creatives.filter((c) => isActive(c, now, activeWithinDays));
  const advertisers = groupByAdvertiser(active);

  const official = [];
  const unofficial = [];
  for (const a of advertisers) {
    const seen = prev[a.advertiserId];
    const seenCreatives = new Set((seen && seen.creatives) || []);
    a.official = isOfficial(a, target);
    a.isNew = !seen;
    a.newCreatives = a.creatives.filter((c) => !seenCreatives.has(c.creativeId));
    (a.official ? official : unofficial).push(a);
  }
  unofficial.sort((x, y) => Number(y.isNew) - Number(x.isNew) || y.creatives.length - x.creatives.length);

  return {
    target,
    firstRun,
    activeWindow: activeWithinDays,
    totalAdvertisers: advertisers.length,
    totalCreatives: active.length,
    official,
    unofficial,
    newUnofficial: unofficial.filter((a) => a.isNew),
    returningWithNewAds: unofficial.filter((a) => !a.isNew && a.newCreatives.length),
    officialNameMatchedOnly: official.filter(
      (a) => !(target.officialAdvertiserIds || []).includes(a.advertiserId),
    ),
  };
}

// State keeps every advertiser ever seen, not just today's, so one who
// pauses for a week and comes back is "returning", not "new".
export function nextState(prevState, creatives, now = Date.now()) {
  const advertisers = { ...((prevState && prevState.advertisers) || {}) };
  for (const c of creatives) {
    const a = (advertisers[c.advertiserId] = advertisers[c.advertiserId]
      ? { ...advertisers[c.advertiserId], creatives: [...advertisers[c.advertiserId].creatives] }
      : { name: c.advertiserName, firstSeen: new Date(now).toISOString(), creatives: [] });
    a.name = c.advertiserName;
    a.lastSeen = new Date(now).toISOString();
    if (!a.creatives.includes(c.creativeId)) a.creatives.push(c.creativeId);
  }
  return { lastRun: new Date(now).toISOString(), advertisers };
}
