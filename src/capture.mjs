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

// Ad iframes carry their rendering script as text nodes, and innerText hands
// it back as one enormous "line". Nothing an advertiser writes looks like this.
function looksLikeCode(line) {
  return (
    line.length > 300 ||
    /function\s*\(|=>|\bconst |\bvar |document\.|window\.|JSON\.parse|\}\)\(\)/.test(line) ||
    (line.match(/[{};=]/g) || []).length > 4
  );
}

export function cleanAdText(chunks) {
  const seen = new Set();
  const out = [];
  for (const chunk of chunks) {
    for (const raw of String(chunk || '').split('\n')) {
      const line = raw.replace(/\s+/g, ' ').trim();
      if (!line || line.length < 2 || CHROME_TEXT.test(line) || looksLikeCode(line) || seen.has(line)) continue;
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

// Text from the frames inside the ad's own box only. The creative page can
// hold other iframes too, and reading every frame on it is how one agency's
// ad came back with a Spanish job listing appended to its copy.
async function adTextFromFrames(el) {
  const chunks = [];
  const walk = async (frame) => {
    try {
      chunks.push(await frame.evaluate(() => (document.body ? document.body.innerText : '')));
    } catch {
      // A frame that navigated away mid-read; skip.
    }
    for (const child of frame.childFrames()) await walk(child);
  };
  const iframes = await el.locator('iframe').elementHandles().catch(() => []);
  if ((await el.evaluate((n) => n.tagName).catch(() => '')) === 'IFRAME') iframes.unshift(await el.elementHandle());
  for (const handle of iframes) {
    const frame = await handle.contentFrame().catch(() => null);
    if (frame) await walk(frame);
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

    const chunks = el ? await adTextFromFrames(el) : [];
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
