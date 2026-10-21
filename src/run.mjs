// Daily scan: for each target domain, list every advertiser Google shows
// running ads to it, flag anyone who is not the official account, and post to
// the client's Slack channel with screenshots of the new ones.
//
//   node src/run.mjs                 scan, post, save state
//   node src/run.mjs --dry-run       scan, print the Slack messages, save nothing
//   node src/run.mjs --no-screenshots

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchDomain } from './transparency.mjs';
import { buildReport, nextState } from './classify.mjs';
import { summaryMessage, creativeReply, Slack } from './slack.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const SHOTS = !args.has('--no-screenshots');

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

function stateFile(target) {
  return path.join(ROOT, 'state', `${target.domain.replace(/[^a-z0-9.-]/gi, '_')}.json`);
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

async function scanTarget(target, config, slack, browserCtx) {
  const region = config.region || 'US';
  const channel = process.env[target.slackChannelEnv] || target.slackChannelId;
  if (!DRY && !channel) throw new Error(`${target.domain}: no Slack channel — set ${target.slackChannelEnv}`);

  const prevState = await readJson(stateFile(target), null);
  const { creatives, truncated } = await searchDomain({
    domain: target.domain,
    region,
    max: config.maxCreativesPerTarget || 2000,
  });
  const report = buildReport({
    target,
    creatives,
    prevState,
    activeWithinDays: config.activeWithinDays || 7,
  });

  console.log(
    `${target.domain}: ${creatives.length} creatives, ${report.totalAdvertisers} active advertisers, ` +
      `${report.unofficial.length} unauthorized (${report.newUnofficial.length} new)`,
  );
  for (const a of [...report.official, ...report.unofficial]) {
    console.log(`  ${a.official ? 'OFFICIAL ' : 'FLAGGED  '} ${a.advertiserId}  ${a.advertiserName}  (${a.creatives.length} ads)`);
  }

  const outDir = path.join(ROOT, 'out', target.domain);
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

  const shouldPost = report.unofficial.length || config.postWhenClean;
  const summary = summaryMessage(report, { region, truncated });
  const captures = SHOTS && browserCtx ? pickCaptures(report, config.maxScreenshotsPerAdvertiser || 3, config.maxScreenshotsPerRun || 25) : [];

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

  // State moves only after the post, so a failed Slack call means tomorrow
  // still reports these as new rather than silently swallowing them.
  if (!DRY) await writeFile(stateFile(target), JSON.stringify(nextState(prevState, creatives), null, 2) + '\n');
  return report;
}

async function main() {
  const config = await readJson(path.join(ROOT, 'config.json'));
  const token = process.env.SLACK_BOT_TOKEN;
  if (!DRY && !token) throw new Error('SLACK_BOT_TOKEN is not set (use --dry-run to test without Slack)');
  const slack = token ? new Slack(token) : null;

  let browser = null;
  let context = null;
  if (SHOTS) {
    const { openBrowser } = await import('./capture.mjs');
    ({ browser, context } = await openBrowser());
  }

  const failures = [];
  try {
    for (const target of config.targets) {
      try {
        await scanTarget(target, config, slack, context);
      } catch (err) {
        console.error(`${target.domain}: ${err.stack || err}`);
        failures.push(`${target.domain}: ${err.message}`);
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
    console.error(err);
    process.exit(1);
  });
}
