// Daily scan: for each client domain, list every advertiser Google shows
// running ads to it, flag anyone who is not the official account, and post to
// the client's Slack channel with screenshots of the new ones.
//
//   node src/run.mjs                      scan every enabled client, post, save state
//   node src/run.mjs --dry-run            scan, print the Slack messages, post nothing
//   node src/run.mjs --slack-test         post a "connected" line to each channel, no scan
//   node src/run.mjs --only=directmeds.com
//   node src/run.mjs --no-screenshots     scan without taking screenshots
//
// Every scan, dry or real, writes results/<domain>.json. That file is what the
// setup page shows — including the advertiser IDs needed to pin the official
// account — so a dry run is useful from the page, not only from the log.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchDomain } from './transparency.mjs';
import { buildReport, nextState } from './classify.mjs';
import { summaryMessage, creativeReply, Slack } from './slack.mjs';
import { validateConfig, resultFileName } from './config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const args = new Set(argv);
const DRY = args.has('--dry-run');
const SLACK_TEST = args.has('--slack-test');
const SHOTS = !args.has('--no-screenshots') && !SLACK_TEST;
let SIGNED_IN = false;
const ONLY = (argv.find((a) => a.startsWith('--only=')) || '').slice(7).trim().toLowerCase();

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

const stateFile = (t) => path.join(ROOT, 'state', resultFileName(t.domain));
const resultFile = (t) => path.join(ROOT, 'results', resultFileName(t.domain));

export function channelFor(target, env = process.env) {
  return target.slackChannelId || (target.slackChannelEnv && env[target.slackChannelEnv]) || '';
}

// New advertisers first, then new ads from known ones; text ads first within
// each, because brand-term bidding is search text ads and those are the ones
// worth seeing. Capped so a flood of display creatives cannot run for an hour.
export function pickCaptures(report, perAdvertiser, perRun) {
  const rank = (c) => (c.format === 'text' ? 0 : 1);
  const picks = [];
  for (const a of [...report.newUnofficial, ...report.returningWithNewAds]) {
    const pool = (a.isNew ? a.creatives : a.newCreatives).slice().sort((x, y) => rank(x) - rank(y));
    for (const c of pool.slice(0, perAdvertiser)) picks.push({ advertiser: a, creative: c });
  }
  return picks.slice(0, perRun);
}

// What the setup page shows for a client. Small on purpose: it is committed
// every day, and the full report with every creative is in the run artifact.
export function resultSummary(report, { dryRun, truncated, now = Date.now() }) {
  const row = (a) => ({
    id: a.advertiserId,
    name: a.advertiserName,
    official: a.official,
    isNew: a.isNew,
    ads: a.creatives.length,
    newAds: a.newCreatives.length,
    formats: [...new Set(a.creatives.map((c) => c.format))],
    lastShown: a.lastShown,
    url: a.creatives[0].url.replace(/\/creative\/[^?]+/, ''),
    active: a.active !== false,
  });
  return {
    ok: true,
    scannedAt: new Date(now).toISOString(),
    dryRun: Boolean(dryRun),
    truncated: Boolean(truncated),
    activeWithinDays: report.activeWindow,
    totalAdvertisers: report.totalAdvertisers,
    totalAds: report.totalCreatives,
    unauthorized: report.unofficial.length,
    newUnauthorized: report.newUnofficial.length,
    totalAllTime: report.totalAllTime,
    advertisers: [
      ...[...report.official, ...report.unofficial].map(row),
      ...report.inactive.map((a) => row({ ...a, isNew: false, newCreatives: [], active: false })),
    ],
  };
}

async function writeResult(target, body) {
  await mkdir(path.join(ROOT, 'results'), { recursive: true });
  await writeFile(resultFile(target), JSON.stringify({ domain: target.domain, name: target.name, ...body }, null, 2) + '\n');
}

async function slackTest(target, slack) {
  const channel = channelFor(target);
  if (!channel) throw new Error(`no Slack channel ID set for ${target.name}`);
  await slack.post(
    channel,
    `:white_check_mark: Ad transparency alerts are connected for *${target.domain}*. ` +
      `A daily report on who is advertising to this site will arrive here around noon Eastern.`,
  );
  console.log(`${target.domain}: Slack test posted`);
}

async function scanTarget(target, config, slack, browserCtx) {
  const region = config.region || 'US';
  const channel = channelFor(target);
  // A client added on the page but not wired to Slack yet is skipped, not
  // failed: "Test scan" works without a channel, and the page says why the
  // daily report is not arriving.
  if (!DRY && !channel) {
    console.log(`${target.domain}: skipped — no Slack channel ID yet`);
    return;
  }

  const prevState = await readJson(stateFile(target), null);
  const { creatives, truncated, shown, tokenKey, requestBody } = await searchDomain({
    context: browserCtx,
    signedIn: SIGNED_IN,
    domain: target.domain,
    region,
    max: config.maxCreativesPerTarget,
  });
  console.log(`${target.domain}: Google's page shows ${shown == null ? 'no count' : `~${shown} ads`}; read ${creatives.length}` +
    `${truncated ? ' (stopped at the cap)' : ''}; paging field ${tokenKey}`);
  console.log(`  request: ${JSON.stringify(requestBody).slice(0, 400)}`);
  const report = buildReport({ target, creatives, prevState, activeWithinDays: config.activeWithinDays });

  console.log(
    `${target.domain}: ${creatives.length} creatives, ${report.totalAdvertisers} active advertisers, ` +
      `${report.unofficial.length} unauthorized (${report.newUnofficial.length} new)`,
  );
  for (const a of [...report.official, ...report.unofficial]) {
    console.log(`  ${a.official ? 'OFFICIAL ' : 'FLAGGED  '} ${a.advertiserId}  ${a.advertiserName}  (${a.creatives.length} ads)`);
  }
  for (const a of report.inactive) {
    console.log(`  older     ${a.advertiserId}  ${a.advertiserName}  (${a.creatives.length} ads, last shown ${String(a.lastShown).slice(0, 10)})`);
  }

  const outDir = path.join(ROOT, 'out', target.domain);
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

  const shouldPost = report.unofficial.length || config.postWhenClean;
  const summary = summaryMessage(report, { region, truncated });
  const captures = SHOTS ? pickCaptures(report, config.maxScreenshotsPerAdvertiser, config.maxScreenshotsPerRun) : [];

  let threadTs = null;
  if (shouldPost) {
    if (DRY) console.log('\n--- Slack summary ---\n' + summary + '\n');
    else threadTs = (await slack.post(channel, summary)).ts;
  }

  if (captures.length) {
    const { captureCreative } = await import('./capture.mjs');
    for (const { advertiser, creative } of captures) {
      const cap = await captureCreative(browserCtx, creative, outDir);
      const text = creativeReply(advertiser, creative, cap);
      if (DRY) {
        console.log('--- thread reply ---\n' + text + (cap.ok ? `\n[screenshot: ${cap.file}]` : '') + '\n');
        continue;
      }
      try {
        if (cap.ok) await slack.upload(channel, cap.file, text, threadTs);
        else await slack.post(channel, text, threadTs);
      } catch (err) {
        // A missing files:write scope must not lose the ad copy.
        console.warn(`  upload failed for ${creative.creativeId}: ${err.message}`);
        await slack.post(channel, `${text}\n_(screenshot upload failed: ${err.message})_`, threadTs);
      }
    }
  }

  await writeResult(target, resultSummary(report, { dryRun: DRY, truncated }));
  // State moves only after a real post, so a failed Slack call means tomorrow
  // still reports these as new rather than silently swallowing them, and a
  // dry run never uses up the "new" that the first real report should show.
  if (!DRY) await writeFile(stateFile(target), JSON.stringify(nextState(prevState, creatives), null, 2) + '\n');
}

async function main() {
  const { config, errors } = validateConfig(await readJson(path.join(ROOT, 'config.json'), {}));
  if (errors.length) throw new Error(`config.json is invalid:\n  ${errors.join('\n  ')}`);

  let targets = config.targets.filter((t) => t.enabled);
  if (ONLY) {
    targets = config.targets.filter((t) => t.domain === ONLY);
    if (!targets.length) throw new Error(`No client with domain ${ONLY} in config.json`);
  }
  if (!targets.length) {
    console.log('No enabled clients to scan.');
    return;
  }

  const token = process.env.SLACK_BOT_TOKEN;
  if (!DRY && !token) throw new Error('SLACK_BOT_TOKEN is not set (use --dry-run to test without Slack)');
  const slack = token ? new Slack(token) : null;

  // The search itself runs in the browser now, so every scan needs one.
  let browser = null;
  let context = null;
  if (!SLACK_TEST) {
    const { openBrowser } = await import('./capture.mjs');
    let signedIn;
    ({ browser, context, signedIn } = await openBrowser());
    SIGNED_IN = signedIn;
  }

  const failures = [];
  try {
    for (const target of targets) {
      try {
        if (SLACK_TEST) await slackTest(target, slack);
        else await scanTarget(target, config, slack, context);
      } catch (err) {
        console.error(`${target.domain}: ${err.stack || err}`);
        failures.push(`${target.domain}: ${err.message}`);
        // The page shows this instead of yesterday's numbers, which would
        // otherwise read as a scan that worked.
        if (!SLACK_TEST) await writeResult(target, { ok: false, scannedAt: new Date().toISOString(), dryRun: DRY, error: err.message });
      }
    }
  } finally {
    if (browser) await browser.close();
  }

  if (failures.length) {
    // Scanner failures go to the internal channel, never the client's: "our
    // monitoring broke" is not a message for a shared Slack Connect channel.
    const errChannel = process.env.SLACK_ERROR_CHANNEL;
    if (slack && errChannel && !DRY) {
      const run = process.env.GITHUB_RUN_URL ? `\n${process.env.GITHUB_RUN_URL}` : '';
      await slack.post(errChannel, `:x: Ad transparency scan failed\n${failures.join('\n')}${run}`).catch(() => {});
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
