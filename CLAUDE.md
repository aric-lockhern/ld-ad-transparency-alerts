# ld-ad-transparency-alerts — guide for Claude Code

Daily scan of the Google Ads Transparency Center for every advertiser running ads to a client's
website. Anyone not on the client's official list is flagged in the client's Slack channel, with
screenshots. Read `README.md` for setup.

## Architecture
- **`config.json`** is the only list of clients. The scan reads it; the setup page writes it
  through the GitHub API. Never add a second store (Blobs, a Sheet) — the scanner would not read it.
- **Scan** (`src/run.mjs`, GitHub Actions `daily-scan.yml`): noon US Eastern via two UTC crons
  and a guard keyed on which cron fired. Writes `results/<domain>.json` (what the page shows) on
  every scan, dry or real, and `state/<domain>.json` (seen advertisers/ads) only after a real post.
- **Setup page** (`public/index.html` + `netlify/functions/admin.mjs` → `netlify/lib/admin.mjs`):
  Netlify, PIN-gated by `ADMIN_PIN`, `GITHUB_TOKEN` scoped to this repo only.
- **`src/config.mjs`** validates config for both the page's save and the scan. Change a field there.

## Invariants
1. **Fail loud, never read as zero.** No public API exists. `src/transparency.mjs` opens the
   real Transparency Center page, captures the `SearchCreatives` request *that page* sends, and
   pages by replaying it. **Never hand-build that request**: the first version did, and Google
   returned 17 ads from an unrelated agency where its page showed ~2K. A changed response shape
   throws, paging that repeats throws, and a total under half of Google's printed "~N ads" count
   throws. A scan that breaks must never post "all clear".
2. **Failures go to `SLACK_ERROR_CHANNEL`, never a client channel.** Client channels are often
   Slack Connect.
3. **Dry runs never touch `state/`**, or the first real report loses its "NEW" markers.
4. **Official is by pinned `AR…` ID first, name second.** The name match is the bootstrap only.
5. **Secrets stay out of the repo**: `SLACK_BOT_TOKEN`, `SLACK_ERROR_CHANNEL`, `GOOGLE_COOKIES`,
   `DATAFORSEO_LOGIN`/`_PASSWORD` (GitHub secrets),
   `ADMIN_PIN`, `GITHUB_TOKEN` (Netlify env). Slack channel IDs are not secrets and live in config.

6. **`GOOGLE_COOKIES` is a whole Google account.** Anonymous Transparency Center visits see a
   fraction of the ads (17 vs ~2K for directmeds.com; DataForSEO sees the same 17), so the scan
   runs signed in. `src/session.mjs` loads only google.com cookies, never logs a value, and a
   signed-out session throws. Never fall back to anonymous: that is a silent under-count.

## Tests
`npm test` (node, offline — also the Netlify build gate) and `npm run test:ui` (setup page in
Chromium, stubbed backend). Neither proves the live Transparency Center RPC works; only a real
"Test scan" does. Say so rather than implying otherwise.
