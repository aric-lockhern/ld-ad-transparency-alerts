# ld-ad-transparency-alerts

Once a day at noon US Eastern, this tool checks the [Google Ads Transparency Center](https://adstransparency.google.com/)
for every advertiser running ads that point at a client's website. Anyone who isn't the client's
official advertiser gets flagged in Slack, with screenshots and the ad copy for new offenders.

First client: **directmeds.com**. The official advertiser is **Direct Meds LLC**, and every other
advertiser is treated as an unauthorized affiliate.

## What lands in Slack

One message a day in the client channel:

```
🚨 2 NEW unauthorized advertisers on directmeds.com
5 advertisers ran ads pointing to directmeds.com in the last 7 days — 1 official, 4 not authorized.

🆕 • Rx Savings Partners Inc — 3 ads (text), last shown 2026-10-20
🆕 • Meds Deals Co — 1 ad (text), last shown 2026-10-21
   • Some Affiliate LLC — 6 ads (text/image), last shown 2026-10-19 · 2 new ads
   • ...
Screenshots and ad copy for new advertisers are in the thread.
```

The thread under it has one reply per new ad: a screenshot taken from the Transparency Center, the
ad copy (headline and description text), first and last shown dates, and a link to the ad. An
advertiser that keeps running shows up in the daily list with no fresh screenshots, until it
launches an ad we haven't seen before.

On a day with no unauthorized advertisers it posts a one-line all-clear. Set `postWhenClean: false`
in `config.json` to stay silent on clean days.

If the scan itself fails (Google changes its internal API, or Slack refuses the token), the error
goes to `SLACK_ERROR_CHANNEL`, an internal channel, never the client's. The GitHub run also fails
and emails the repo owner.

## Setup

1. **Slack app.** Create one at api.slack.com/apps, add the bot scopes `chat:write` and `files:write`,
   install it to the workspace, and copy the bot token (`xoxb-…`). Invite the bot to the shared
   client channel (`/invite @YourApp`). Inviting it is what lets it post into a Slack Connect channel.
2. **Repo secrets** (Settings → Secrets and variables → Actions):
   | Secret | Value |
   |---|---|
   | `SLACK_BOT_TOKEN` | the `xoxb-…` token |
   | `SLACK_CHANNEL_DIRECTMEDS` | channel ID of the shared client channel (`C0…`; open the channel details, it's at the bottom) |
   | `SLACK_ERROR_CHANNEL` | optional. Channel ID of an internal channel for scan failures |
3. **First run.** Go to Actions → *Daily ad transparency scan* → *Run workflow*, and tick **Dry run**.
   The log lists every advertiser it found, marked OFFICIAL or FLAGGED, along with their
   `AR…` IDs. Screenshots go to the run's artifacts.
4. **Pin the official advertiser ID.** Copy Direct Meds LLC's `AR…` ID from that log into
   `officialAdvertiserIds` in `config.json`. Until you do, the official account is matched by
   name, and the Slack message reminds you to pin it.
5. Run it once for real (without Dry run). From then on it runs every day at noon Eastern.

## Adding another client

Add an entry to `targets` in `config.json`, then add a secret with the name you gave
`slackChannelEnv`, and add that secret to the `env:` block of the *Scan and alert* step in
`.github/workflows/daily-scan.yml`.

## Config (`config.json`)

| Key | Meaning |
|---|---|
| `region` | Transparency Center region filter: `US`, `CA`, `GB`, `AU` or `anywhere` |
| `activeWithinDays` | an ad counts as running if Google last showed it within this many days |
| `maxScreenshotsPerAdvertiser` / `maxScreenshotsPerRun` | caps that keep a flood of creatives from making the run slow or the thread unreadable |
| `targets[].officialAdvertiserNames` | verified advertiser names that count as official (case and punctuation ignored) |
| `targets[].officialAdvertiserIds` | `AR…` IDs that count as official. These are exact, so prefer them |

## How it works, and its limits

- **No official API exists.** The tool calls the same internal endpoint the Transparency Center
  page calls when you search a website (`SearchService/SearchCreatives`). Google can change it
  without notice. If the response shape changes, the scan fails loudly instead of reporting
  "0 advertisers". A silent all-clear would be the worst way for this to break.
- **Screenshots and ad copy** come from rendering each ad's own Transparency Center page in
  headless Chromium. The search results don't include the ad text, so rendering the page is the
  only way to get it.
- **It catches ads whose destination is directmeds.com.** An affiliate that bids on the brand
  name but sends clicks to its own domain, which then redirects, won't show up under this
  website. To cover that case, add the affiliate's domain as another target.
- **Keywords aren't public.** The Transparency Center shows an advertiser's ads, not the search
  terms they bid on. A text ad from a non-official advertiser that points at directmeds.com is
  the evidence available. For proof of who appears on brand searches, pair this with Google Ads
  Auction Insights on the official account.
- **Taking action.** Each flagged ad links to its Transparency Center page, which has a
  *Report this ad* option. To enforce against an affiliate directly, use the advertiser's
  verified name and `AR…` ID from the alert.
- `state/` records every advertiser and ad already seen, which is what makes "NEW" mean new.
  The workflow commits it after each run.

## Local use

```
npm ci
npx playwright install chromium
npm test                        # offline unit tests
npm run scan:dry                # real scan, prints the Slack messages, posts nothing
SLACK_BOT_TOKEN=… SLACK_CHANNEL_DIRECTMEDS=C0… npm run scan
```
