// Screenshots and ad copy, taken from the creative's own Transparency Center
// page in a real browser. The search RPC lists creatives but not their text —
// a text ad's headline and description only exist once the page renders the
// preview — so rendering it is the one way to get both the picture and the copy.

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

// Tried in order; the first one present and visible is what gets screenshotted.
// Google does not publish these and renames them, so the fallback is the main
// content column rather than nothing.
const CREATIVE_SELECTORS = [
  'creative-preview',
  '.creative-preview',
  'creative-details .creative-container',
  '.creative-container',
  'iframe[id^="fletch-render"]',
  'main',
];

const CHROME_TEXT = /^(ads transparency center|google|sign in|privacy|terms|about|faq|report ad|see all ads|last shown|first shown|format|region|advertiser|verified|this advertiser|.*cookies.*)$/i;

export function cleanAdText(chunks) {
  const seen = new Set();
  const out = [];
  for (const chunk of chunks) {
    for (const raw of String(chunk || '').split('\n')) {
      const line = raw.replace(/\s+/g, ' ').trim();
      if (!line || line.length < 2 || CHROME_TEXT.test(line) || seen.has(line)) continue;
      seen.add(line);
      out.push(line);
    }
  }
  return out.join('\n').slice(0, 1200);
}

export async function openBrowser() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1100 },
    deviceScaleFactor: 2,
    locale: 'en-US',
  });
  return { browser, context };
}

async function adTextFromFrames(page) {
  const chunks = [];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      chunks.push(await frame.evaluate(() => (document.body ? document.body.innerText : '')));
    } catch {
      // Cross-origin frames that navigated away mid-read; skip.
    }
  }
  return chunks;
}

// Never throws: one creative that will not render must not cost the report
// for every other advertiser. The failure is returned and shown on its row.
export async function captureCreative(context, creative, outDir) {
  const page = await context.newPage();
  try {
    await page.goto(creative.url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(2500); // the preview iframe paints after network idle

    let el = null;
    for (const sel of CREATIVE_SELECTORS) {
      const candidate = page.locator(sel).first();
      if ((await candidate.count()) && (await candidate.isVisible().catch(() => false))) {
        el = candidate;
        break;
      }
    }

    const chunks = await adTextFromFrames(page);
    if (el) chunks.push(await el.innerText().catch(() => ''));
    const adText = cleanAdText(chunks);

    await mkdir(outDir, { recursive: true });
    const file = path.join(outDir, `${creative.advertiserId}_${creative.creativeId}.png`);
    if (el) await el.screenshot({ path: file, timeout: 15000 });
    else await page.screenshot({ path: file, fullPage: false });

    return { ok: true, file, adText };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err).split('\n')[0] };
  } finally {
    await page.close().catch(() => {});
  }
}
