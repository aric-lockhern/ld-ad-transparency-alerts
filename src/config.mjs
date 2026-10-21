// The one definition of a valid config.json. The setup UI's save and the
// scanner both go through it, so the page cannot write something the daily
// run would refuse, and a hand edit gets the same check.

import { REGIONS } from './transparency.mjs';

export const DEFAULTS = {
  region: 'US',
  activeWithinDays: 1,
  maxCreativesPerTarget: 5000,
  maxScreenshotsPerAdvertiser: 3,
  maxScreenshotsPerRun: 25,
  postWhenClean: true,
};

const DOMAIN = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const CHANNEL = /^[CG][A-Z0-9]{8,}$/;
const ADVERTISER = /^AR\d{10,}$/;

// People paste "https://www.directmeds.com/shop" — what they mean is the domain.
export function cleanDomain(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '');
}

function list(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[\n,]/);
  return [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))];
}

function num(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// Returns { config, errors }. errors is a list of sentences naming the client
// and field, because "invalid config" is not something anyone can act on.
export function validateConfig(input) {
  const errors = [];
  const src = input && typeof input === 'object' ? input : {};
  const region = src.region == null ? DEFAULTS.region : String(src.region);
  if (region !== 'anywhere' && !REGIONS[region.toUpperCase()]) {
    errors.push(`Region "${region}" is not supported. Use one of: ${Object.keys(REGIONS).join(', ')}, anywhere.`);
  }

  const config = {
    region: region === 'anywhere' ? region : region.toUpperCase(),
    activeWithinDays: num(src.activeWithinDays, DEFAULTS.activeWithinDays, 1, 90),
    maxCreativesPerTarget: num(src.maxCreativesPerTarget, DEFAULTS.maxCreativesPerTarget, 50, 10000),
    maxScreenshotsPerAdvertiser: num(src.maxScreenshotsPerAdvertiser, DEFAULTS.maxScreenshotsPerAdvertiser, 0, 10),
    maxScreenshotsPerRun: num(src.maxScreenshotsPerRun, DEFAULTS.maxScreenshotsPerRun, 0, 100),
    postWhenClean: src.postWhenClean == null ? DEFAULTS.postWhenClean : Boolean(src.postWhenClean),
    targets: [],
  };

  const seen = new Set();
  (Array.isArray(src.targets) ? src.targets : []).forEach((t, i) => {
    const domain = cleanDomain(t && t.domain);
    const label = (t && String(t.name || '').trim()) || domain || `Client ${i + 1}`;
    const target = {
      name: label,
      domain,
      enabled: t.enabled !== false,
      officialAdvertiserNames: list(t.officialAdvertiserNames),
      officialAdvertiserIds: list(t.officialAdvertiserIds),
      slackChannelId: String(t.slackChannelId || '').trim().toUpperCase(),
      // Display only: the picker stores the name it showed, so the card can
      // say where reports go without a Slack call. The ID is what posts.
      slackChannelName: String(t.slackChannelName || '').trim().replace(/^#/, '').slice(0, 80),
    };
    if (t.slackChannelEnv) target.slackChannelEnv = String(t.slackChannelEnv);

    if (!DOMAIN.test(domain)) errors.push(`${label}: "${t.domain || ''}" is not a website domain (e.g. directmeds.com).`);
    else if (seen.has(domain)) errors.push(`${label}: ${domain} is listed twice.`);
    seen.add(domain);
    if (!target.officialAdvertiserNames.length && !target.officialAdvertiserIds.length) {
      errors.push(`${label}: add the official advertiser name, or every advertiser will be flagged — including the client.`);
    }
    for (const id of target.officialAdvertiserIds) {
      if (!ADVERTISER.test(id)) errors.push(`${label}: "${id}" is not an advertiser ID (they look like AR12345678901234567890).`);
    }
    if (target.slackChannelId && !CHANNEL.test(target.slackChannelId)) {
      errors.push(`${label}: "${target.slackChannelId}" is not a Slack channel ID (it starts with C, e.g. C0123ABCDEF — not the #name).`);
    }
    config.targets.push(target);
  });

  return { config, errors };
}

export function resultFileName(domain) {
  return `${domain.replace(/[^a-z0-9.-]/gi, '_')}.json`;
}
