import test from 'node:test';
import assert from 'node:assert/strict';
import { Slack, explainJoinError } from '../src/slack.mjs';
import { joinSlackChannel } from '../netlify/lib/admin.mjs';

function fakeSlack(replies) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = url.split('/api/')[1];
    calls.push(method);
    const next = replies[method].shift();
    return { ok: true, json: async () => next };
  };
  return { slack: new Slack('xoxb-t', { fetchImpl }), calls };
}

test('a post refused with not_in_channel joins the channel and retries once', async () => {
  const { slack, calls } = fakeSlack({
    'chat.postMessage': [{ ok: false, error: 'not_in_channel' }, { ok: true, ts: '1.2' }],
    'conversations.join': [{ ok: true, channel: { id: 'C0123ABCDEF' } }],
  });
  const out = await slack.post('C0123ABCDEF', 'hi');
  assert.equal(out.ts, '1.2');
  assert.deepEqual(calls, ['chat.postMessage', 'conversations.join', 'chat.postMessage']);
});

test('a private channel says to /invite, instead of a raw Slack code', async () => {
  const { slack } = fakeSlack({
    'chat.postMessage': [{ ok: false, error: 'not_in_channel' }],
    'conversations.join': [{ ok: false, error: 'method_not_supported_for_channel_type' }],
  });
  await assert.rejects(slack.post('G0123ABCDEF', 'hi'), /private.*\/invite @your-bot/);
});

test('other Slack errors are not retried', async () => {
  const { slack, calls } = fakeSlack({ 'chat.postMessage': [{ ok: false, error: 'channel_not_found' }] });
  await assert.rejects(slack.post('C0123ABCDEF', 'hi'), /channel_not_found/);
  assert.deepEqual(calls, ['chat.postMessage']);
});

test('join error wording covers the missing scope and shared-channel restrictions', () => {
  assert.match(explainJoinError('missing_scope', 'channels:join'), /add the channels:join scope/);
  assert.match(explainJoinError('restricted_action'), /does not allow apps to join/);
});

test('page join: validates the channel ID and reports Slack refusals readably', async () => {
  await assert.rejects(joinSlackChannel('', 'C0123ABCDEF'), /SLACK_BOT_TOKEN is not set/);
  await assert.rejects(joinSlackChannel('xoxb-t', '#general'), /not a Slack channel ID/);
  const ok = async () => ({ json: async () => ({ ok: true, channel: { name: 'client-directmeds-ext' } }) });
  assert.deepEqual(await joinSlackChannel('xoxb-t', 'C0123ABCDEF', ok), { joined: true, name: 'client-directmeds-ext' });
  const scope = async () => ({ json: async () => ({ ok: false, error: 'missing_scope', needed: 'channels:join' }) });
  await assert.rejects(joinSlackChannel('xoxb-t', 'C0123ABCDEF', scope), /add the channels:join scope/);
});
