// Thin Netlify v2 wrapper at /api/admin. Logic lives in netlify/lib/admin.mjs.
import { GitHub, handle, pinOk } from '../lib/admin.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export default async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
  if (!process.env.ADMIN_PIN) return json({ ok: false, error: 'ADMIN_PIN is not set on this Netlify site.' }, 500);
  if (!pinOk(req.headers.get('x-admin-pin'), process.env.ADMIN_PIN)) return json({ ok: false, error: 'pin' }, 401);
  if (!process.env.GITHUB_TOKEN) return json({ ok: false, error: 'GITHUB_TOKEN is not set on this Netlify site.' }, 500);

  let body = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'Body must be JSON' }, 400);
  }

  const gh = new GitHub({
    token: process.env.GITHUB_TOKEN,
    repo: process.env.GITHUB_REPO || 'aric-lockhern/ld-ad-transparency-alerts',
    branch: process.env.GITHUB_BRANCH || 'main',
  });

  try {
    const out = await handle(String(body.action || ''), body, gh);
    if (out && out.status) return json(out.body, out.status);
    return json({ ok: true, ...out });
  } catch (err) {
    return json({ ok: false, error: err.message }, err.status || 500);
  }
};

export const config = { path: '/api/admin' };
