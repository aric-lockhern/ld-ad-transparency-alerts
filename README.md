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

There are two halves:

- **The setup page** (Netlify): add clients, run a test scan, see who was found, and pin the
  client's own account. It holds no data of its own. It edits `config.json` in this repo
  through the GitHub API and starts runs.
- **The scan** (GitHub Actions): runs daily at noon Eastern, plus whenever the page starts a run.
  It posts to Slack and saves each client's latest results to `results/`, which the page reads.

### 1. Slack app (once)

Create an app at api.slack.com/apps (*From scratch*). Under **OAuth & Permissions**, add the bot
scopes `chat:write`, `files:write`, `channels:read`, `groups:read` and `channels:join`. The read scopes let
the setup page list channels to pick from; `channels:join` lets the bot add itself to a public
channel. Slack only lets a bot into a private channel by invitation (`/invite @your-bot`), then install it to the workspace and copy the **Bot User
OAuth Token** (`xoxb-…`).

### 2. GitHub secrets (once)

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `SLACK_BOT_TOKEN` | the `xoxb-…` token |
| `SLACK_ERROR_CHANNEL` | optional. ID of an internal channel that gets "the scan broke" messages. These never go to a client channel |

### 3. GitHub token for the page (once)

github.com → **Settings → Developer settings → Fine-grained tokens → Generate new token**:
- Repository access: **Only select repositories** → `ld-ad-transparency-alerts`
- Permissions: **Contents: Read and write**, **Actions: Read and write**

### 4. Netlify site (once)

1. Netlify → **Add new site → Import an existing project** → GitHub → this repo. The build
   settings come from `netlify.toml`, so leave them as they are.
2. **Site configuration → Environment variables**:

   | Variable | Value |
   |---|---|
   | `ADMIN_PIN` | the PIN the page asks for |
   | `GITHUB_TOKEN` | the fine-grained token from step 3 |
   | `GITHUB_REPO` | optional. Defaults to `aric-lockhern/ld-ad-transparency-alerts` |
   | `SLACK_BOT_TOKEN` | the same `xoxb-…` token. Lets the page list Slack channels to pick from; without it you type the channel ID |

3. Redeploy (**Deploys → Trigger deploy**) so the function picks up the variables.

### 5. Each client (on the page)

1. In Slack, invite the bot to the channel the reports should go to (`/invite @YourBot`). It needs
   to be a member to post, including in a shared Slack Connect channel.
2. **+ Add client**: enter the website and the official advertiser name as Google shows it, then
   pick the channel from the list. Shared channels are marked "shared with client"; a channel the
   bot is not in yet is marked "bot not invited". Press **Refresh list** after inviting it.
3. **Send test report**: a real report marked "Test report", with screenshots in the thread, appears
   in the channel a few minutes later. It does not count, so the first daily report still marks
   everyone as new.
4. **Test scan**: scans without posting anything. A few minutes later the card lists every
   advertiser found.
5. On the client's own account, press **This is the client**. That pins its `AR…` ID, so a
   look-alike name can't pass as official.
6. That's it. The daily scan picks the client up from then on. **Scan & post now** sends a report
   immediately.

The first real report lists every non-official advertiser as new, because the tool hasn't seen any
of them before. After that, only new advertisers and new ads get screenshots.

## Config (`config.json`)

The page edits this file, and you can also edit it by hand. Both go through the same validation
(`src/config.mjs`).

| Key | Meaning |
|---|---|
| `region` | Transparency Center region filter: `US`, `CA`, `GB`, `AU` or `anywhere` |
| `activeWithinDays` | an ad counts as running if Google last showed it within this many days |
| `maxScreenshotsPerAdvertiser` / `maxScreenshotsPerRun` | caps that keep a flood of creatives from making the run slow or the thread unreadable |
| `targets[].officialAdvertiserNames` | verified advertiser names that count as official (case and punctuation ignored) |
| `targets[].officialAdvertiserIds` | `AR…` IDs that count as official. These are exact, so prefer them |
| `targets[].slackChannelId` | the client's Slack channel. With none, the daily scan skips the client |
| `targets[].enabled` | `false` pauses the client without deleting it |

## Signed-in scanning (needed for the full data set)

Google shows an anonymous visitor a fraction of what it shows a signed-in one. For directmeds.com,
anonymous visits get 17 ads from 4 advertisers, while a signed-in account sees ~2K, including
advertisers such as Leadcap Digital AB. Identical requests get both answers, and DataForSEO's paid
API returns the same 17. So the scan has to run signed in.

It does that with a cookie export of a signed-in Google session, stored as the GitHub secret
`GOOGLE_COOKIES`. **Those cookies are that whole Google account** (Gmail, Drive, Ads), and anyone
who can push to this repo could use them. Prefer a dedicated Google account if a fresh one shows the
full count. The scan loads only google.com cookies, never logs their values, and **fails loudly if
the session is signed out**. It never falls back to the anonymous 17.

1. In Chrome, use a profile signed in to the account the scanner should use. A separate Chrome
   profile is best, because signing out of that profile ends the saved session.
2. Install the **Cookie-Editor** extension.
3. Open `https://adstransparency.google.com/?region=US&domain=directmeds.com` and check that it
   shows the full count (e.g. "~2K ads").
4. Click Cookie-Editor → **Export** → **JSON**. This copies the cookies to your clipboard.
5. Repo → Settings → Secrets and variables → Actions → New repository secret: name `GOOGLE_COOKIES`,
   then paste the export.
6. Actions → **Probe Transparency Center (diagnostic)** → Run workflow. The log should say
   `Session: signed in` and print a count far above 17.

When Google ends the session (sign-out, password change, or a security check), the daily scan fails
with "The saved Google session is signed out". Repeat steps 3–5.

## How it works, and its limits

- **No official API exists.** The scan opens the real Transparency Center page for the site in
  headless Chromium, captures the search request that page sends, and pages through the results
  with it, so it reads exactly what you see in a browser. It also reads Google's own "~2K ads"
  count from the page, and if it collected less than half of that it fails loudly instead of
  reporting. A silent all-clear would be the worst way for this to break.
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
npm test                        # offline unit tests (also the Netlify build gate)
npm run test:ui                 # setup page in headless Chromium, stubbed backend, screenshots in .uicheck/
npm run scan:dry                # real scan, prints the Slack messages, posts nothing
node src/run.mjs --only=directmeds.com --dry-run
```
