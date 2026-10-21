// Slack message composition (pure) and delivery (Web API, bot token).
//
// A bot token rather than an incoming webhook, because a webhook cannot upload
// a file and the screenshots are the part a client acts on.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { domainUrl } from './transparency.mjs';

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function link(url, label) {
  return `<${url}|${esc(label).replace(/\|/g, '/')}>`;
}

function day(iso) {
  return iso ? iso.slice(0, 10) : 'unknown';
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function advertiserLine(a, region) {
  const first = a.creatives[0];
  const url = first.url.replace(/\/creative\/[^?]+/, '');
  const fmt = [...new Set(a.creatives.map((c) => c.format))].join('/');
  const extra = a.newCreatives.length && !a.isNew ? ` · *${plural(a.newCreatives.length, 'new ad')}*` : '';
  return `• ${link(url + (url.includes('?') ? '' : `?region=${region}`), a.advertiserName)} — ${plural(a.creatives.length, 'ad')} (${fmt}), last shown ${day(a.lastShown)}${extra}`;
}

// The top-level message. Detail for each new advertiser is posted as thread
// replies so the channel itself reads as one line per day.
export function summaryMessage(report, { region, truncated }) {
  const { target, unofficial, official, newUnofficial } = report;
  const site = link(domainUrl(target.domain, region), target.domain);
  const lines = [];

  if (!unofficial.length) {
    lines.push(`:white_check_mark: *${esc(target.domain)}* — no unauthorized advertisers in the last ${report.activeWindow} days.`);
    lines.push(`${plural(report.totalAdvertisers, 'advertiser')} running ads to ${site}: ${official.map((a) => esc(a.advertiserName)).join(', ') || 'none'}.`);
  } else {
    const icon = newUnofficial.length ? ':rotating_light:' : ':warning:';
    const headline = newUnofficial.length
      ? `${plural(newUnofficial.length, 'NEW unauthorized advertiser')} on *${esc(target.domain)}*`
      : `${plural(unofficial.length, 'unauthorized advertiser')} still running on *${esc(target.domain)}*`;
    lines.push(`${icon} ${headline}`);
    lines.push(
      `${plural(report.totalAdvertisers, 'advertiser')} ran ads pointing to ${site} in the last ${report.activeWindow} days — ` +
        `${official.length} official, *${unofficial.length} not authorized*.`,
    );
    lines.push('');
    for (const a of unofficial) lines.push(`${a.isNew ? ':new: ' : ''}${advertiserLine(a, region)}`);
    if (newUnofficial.length) lines.push('', '_Screenshots and ad copy for new advertisers are in the thread._');
  }

  if (truncated) lines.push('', `_Only the first ${report.totalCreatives} ads were read — the full list is longer. Raise maxCreativesPerTarget to see all._`);
  if (report.officialNameMatchedOnly.length) {
    const ids = report.officialNameMatchedOnly.map((a) => `\`${a.advertiserId}\``).join(', ');
    lines.push('', `_Official account matched by name only. Pin ${ids} in config.json officialAdvertiserIds so a look-alike name cannot pass._`);
  }
  return lines.join('\n');
}

export function creativeReply(advertiser, creative, capture) {
  const lines = [
    `*${esc(advertiser.advertiserName)}* · \`${advertiser.advertiserId}\``,
    `${link(creative.url, 'View in Ads Transparency Center')} · ${creative.format} ad · first shown ${day(creative.firstShown)} · last shown ${day(creative.lastShown)}`,
  ];
  if (capture && capture.adText) lines.push('>>> ' + esc(capture.adText));
  else if (capture && !capture.ok) lines.push(`_Could not render this ad: ${esc(capture.error)}_`);
  return lines.join('\n');
}

// What to tell a person when the bot cannot put itself in a channel. Slack lets
// a bot join a public channel on its own (scope channels:join); a private
// channel only by invitation, and no scope changes that.
export function explainJoinError(code, needed) {
  if (code === 'missing_scope') {
    return `The bot is not in this channel and cannot join it by itself: add the ${needed || 'channels:join'} scope to the Slack app and reinstall it, or type /invite @your-bot in the channel.`;
  }
  if (code === 'method_not_supported_for_channel_type' || code === 'channel_not_found') {
    return 'This channel is private, and Slack only lets a bot into a private channel by invitation. Type /invite @your-bot in the channel.';
  }
  if (code === 'is_archived') return 'This channel is archived. Pick another one.';
  if (code === 'restricted_action' || code === 'not_allowed_token_type') {
    return 'Your Slack workspace does not allow apps to join this channel by themselves (common for channels shared with another company). Type /invite @your-bot in the channel.';
  }
  return `The bot could not join this channel (${code}). Type /invite @your-bot in the channel.`;
}

export class Slack {
  constructor(token, { fetchImpl = fetch } = {}) {
    this.token = token;
    this.fetch = fetchImpl;
  }

  async call(method, body, { form = false } = {}) {
    const res = await this.fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8',
      },
      body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) {
      const e = new Error(`Slack ${method}: ${json.error}${json.needed ? ` (needs ${json.needed})` : ''}`);
      e.code = json.error;
      e.needed = json.needed;
      throw e;
    }
    return json;
  }

  // Puts the bot in a public channel. Throws a sentence a person can act on.
  async join(channel) {
    try {
      await this.call('conversations.join', { channel });
    } catch (err) {
      throw new Error(explainJoinError(err.code, err.needed));
    }
  }

  // A send that fails because the bot is not in the channel joins it and tries
  // once more, so a channel picked before the bot was invited still works.
  async withJoin(channel, send) {
    try {
      return await send();
    } catch (err) {
      if (err.code !== 'not_in_channel') throw err;
      await this.join(channel);
      return send();
    }
  }

  post(channel, text, threadTs) {
    return this.withJoin(channel, () =>
      this.call('chat.postMessage', { channel, text, thread_ts: threadTs, unfurl_links: false, unfurl_media: false }),
    );
  }

  // files.upload is retired; this is the two-step external upload flow.
  async upload(channel, file, comment, threadTs) {
    const bytes = await readFile(file);
    const filename = path.basename(file);
    const { upload_url, file_id } = await this.call(
      'files.getUploadURLExternal',
      { filename, length: String(bytes.length) },
      { form: true },
    );
    const up = await this.fetch(upload_url, { method: 'POST', body: bytes });
    if (!up.ok) throw new Error(`Slack upload HTTP ${up.status}`);
    return this.withJoin(channel, () =>
      this.call('files.completeUploadExternal', {
        files: [{ id: file_id, title: filename }],
        channel_id: channel,
        thread_ts: threadTs,
        initial_comment: comment,
      }),
    );
  }
}
