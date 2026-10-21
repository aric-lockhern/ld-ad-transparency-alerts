// The setup page's backend. It holds no data of its own: config.json in the
// repo is the one copy the daily scan reads, and this reads and writes that
// file through the GitHub API. A second store (Blobs, a Sheet) would be a
// second copy that the scanner does not read, and the two would disagree.
//
// Env (Netlify → Site configuration → Environment variables):
//   ADMIN_PIN     the PIN the page asks for. Unset = the page refuses everything.
//   GITHUB_TOKEN  fine-grained token on this repo only: Contents read/write,
//                 Actions read/write.
//   GITHUB_REPO   owner/name, default aric-lockhern/ld-ad-transparency-alerts
//   GITHUB_BRANCH default main

import { validateConfig, resultFileName } from '../../src/config.mjs';

const WORKFLOW = 'daily-scan.yml';
const MODES = new Set(['scan', 'dry-run', 'slack-test']);

export function pinOk(given, expected) {
  if (!expected) return false; // no PIN configured = no access at all
  given = String(given || '');
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export class GitHub {
  constructor({ token, repo, branch, fetchImpl = fetch }) {
    this.token = token;
    this.repo = repo;
    this.branch = branch;
    this.fetch = fetchImpl;
  }

  async req(method, p, body) {
    const res = await this.fetch(`https://api.github.com/repos/${this.repo}${p}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'ld-ad-transparency-alerts',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    return { status: res.status, json };
  }

  async readJson(file) {
    const r = await this.req('GET', `/contents/${file}?ref=${encodeURIComponent(this.branch)}`);
    if (r.status === 404) return { data: null, sha: null };
    if (r.status !== 200) throw ghError(r, `read ${file}`);
    return { data: JSON.parse(Buffer.from(r.json.content, 'base64').toString('utf8')), sha: r.json.sha };
  }

  async writeJson(file, data, sha, message) {
    const content = Buffer.from(JSON.stringify(data, null, 2) + '\n').toString('base64');
    const r = await this.req('PUT', `/contents/${file}`, { message, content, sha: sha || undefined, branch: this.branch });
    if (r.status === 409 || r.status === 422) {
      const e = new Error('Someone else saved changes since you opened this page. Reload to see them, then make your edit again.');
      e.status = 409;
      throw e;
    }
    if (r.status !== 200 && r.status !== 201) throw ghError(r, `save ${file}`);
    return r.json.content.sha;
  }

  async dispatch(inputs) {
    const r = await this.req('POST', `/actions/workflows/${WORKFLOW}/dispatches`, { ref: this.branch, inputs });
    if (r.status !== 204) throw ghError(r, 'start the scan');
  }

  async runs(limit = 8) {
    const r = await this.req('GET', `/actions/workflows/${WORKFLOW}/runs?per_page=${limit}`);
    if (r.status !== 200) throw ghError(r, 'list runs');
    return r.json.workflow_runs.map((w) => ({
      id: w.id,
      title: w.display_title,
      event: w.event,
      status: w.status,
      conclusion: w.conclusion,
      createdAt: w.created_at,
      url: w.html_url,
    }));
  }
}

function ghError(r, what) {
  const msg = (r.json && r.json.message) || `HTTP ${r.status}`;
  const hint =
    r.status === 401 ? ' — GITHUB_TOKEN is wrong or expired.' :
    r.status === 403 || r.status === 404 ? ' — GITHUB_TOKEN cannot reach this repo, or lacks Contents/Actions write.' : '';
  const e = new Error(`GitHub refused to ${what}: ${msg}${hint}`);
  e.status = 502;
  return e;
}

export async function handle(action, body, gh) {
  if (action === 'load') {
    const { data, sha } = await gh.readJson('config.json');
    const config = validateConfig(data || {}).config;
    const results = {};
    await Promise.all(
      config.targets.map(async (t) => {
        results[t.domain] = (await gh.readJson(`results/${resultFileName(t.domain)}`)).data;
      }),
    );
    const runs = await gh.runs().catch((e) => ({ error: e.message }));
    return { config, sha, results, runs };
  }

  if (action === 'save') {
    const { config, errors } = validateConfig(body.config);
    if (errors.length) return { status: 400, body: { ok: false, error: 'invalid', errors } };
    const sha = await gh.writeJson('config.json', config, body.sha, body.message || 'Update clients from setup page');
    return { config, sha };
  }

  if (action === 'run') {
    const mode = MODES.has(body.mode) ? body.mode : 'dry-run';
    const target = String(body.target || '').trim().toLowerCase();
    await gh.dispatch({ mode, target });
    return { started: true, mode, target };
  }

  if (action === 'runs') return { runs: await gh.runs() };

  return { status: 400, body: { ok: false, error: `Unknown action ${action}` } };
}
