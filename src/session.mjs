// Signed-in Google session for the scan.
//
// The Transparency Center shows an anonymous visitor a fraction of what it
// shows a signed-in one: for directmeds.com, 17 ads from 4 advertisers
// anonymously against ~2K from many more signed in. Identical request bodies
// get both answers, and DataForSEO's paid API returns the same 17, so the only
// way to the full set is a signed-in session.
//
// GOOGLE_COOKIES (a GitHub secret) holds a cookie export of that session —
// a Cookie-Editor JSON export, or a Playwright storageState, raw or base64.
// These cookies ARE the Google account, so: only google.com cookies are ever
// loaded, no value is ever logged, and a session that has been signed out
// fails the scan instead of quietly falling back to the anonymous 17.

const SAME_SITE = { no_restriction: 'None', none: 'None', lax: 'Lax', strict: 'Strict' };

function isGoogleDomain(domain) {
  const d = String(domain || '').replace(/^\./, '').toLowerCase();
  return d === 'google.com' || d.endsWith('.google.com');
}

// Returns Playwright cookies. Throws a message that never contains a value.
export function parseGoogleCookies(raw) {
  if (!raw || !String(raw).trim()) return [];
  let text = String(raw).trim();
  if (!text.startsWith('[') && !text.startsWith('{')) {
    try {
      text = Buffer.from(text, 'base64').toString('utf8').trim();
    } catch {
      // fall through to the JSON error below
    }
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('GOOGLE_COOKIES is not valid JSON (expected a Cookie-Editor export or a Playwright storage state).');
  }
  const list = Array.isArray(data) ? data : Array.isArray(data.cookies) ? data.cookies : null;
  if (!list) throw new Error('GOOGLE_COOKIES has no cookie list in it.');

  const cookies = list
    .filter((c) => c && c.name && c.value != null && isGoogleDomain(c.domain))
    .map((c) => {
      const expires = c.expires ?? c.expirationDate;
      const sameSite = SAME_SITE[String(c.sameSite || '').toLowerCase()] || (c.sameSite === 'None' || c.sameSite === 'Lax' || c.sameSite === 'Strict' ? c.sameSite : 'Lax');
      return {
        name: String(c.name),
        value: String(c.value),
        domain: String(c.domain),
        path: c.path || '/',
        expires: Number.isFinite(Number(expires)) && Number(expires) > 0 ? Math.floor(Number(expires)) : -1,
        httpOnly: Boolean(c.httpOnly),
        // SameSite=None requires Secure; Google's session cookies are all secure.
        secure: sameSite === 'None' ? true : Boolean(c.secure),
        sameSite,
      };
    });

  if (!cookies.length) throw new Error('GOOGLE_COOKIES holds no google.com cookies. Export them while on a google.com page.');
  // The account cookies; without at least one of these nobody is signed in.
  if (!cookies.some((c) => /^(SID|__Secure-1PSID|__Secure-3PSID|SAPISID)$/.test(c.name))) {
    throw new Error('GOOGLE_COOKIES has google.com cookies but no sign-in cookie (SID / __Secure-1PSID). Export them while signed in.');
  }
  return cookies;
}

// The page shows a "Sign in" button only to anonymous visitors.
export async function assertSignedIn(page) {
  const signIn = page.getByRole('link', { name: /^\s*sign in\s*$/i }).or(page.getByRole('button', { name: /^\s*sign in\s*$/i }));
  if (await signIn.first().isVisible().catch(() => false)) {
    throw new Error(
      'The saved Google session is signed out, so the Transparency Center would only show the anonymous view ' +
        '(a fraction of the ads). Export fresh cookies into the GOOGLE_COOKIES secret — see README, "Signed-in scanning".',
    );
  }
}
