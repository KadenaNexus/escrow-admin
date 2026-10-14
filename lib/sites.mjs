/* ---------- Site watch: is every Kadena Nexus site answering? ----------
 * Checked every 5 minutes (netlify/functions/site-watch.mjs). A site is "down" after 2 failed checks in a row
 * (about 10 minutes, so one slow answer never alerts). One email when it goes down, one when it is back,
 * and a reminder every 6 hours while it stays down.
 */
export const DEFAULT_SITES = [
  { name: 'Marketplace', url: 'https://marketplace.kadena.ws/', expect: 'P2P' },
  // the Marketplace server and its database: this route reads a table, so a 200 means both answer
  { name: 'Marketplace server', url: 'https://marketplace.kadena.ws/api/hidden-offers', expect: '[' },
  { name: 'Kadena Nexus', url: 'https://kadena.ws/' },
  { name: 'Kadena Devs', url: 'https://kadenadevs.kadena.ws/' },
  { name: 'Network Monitor', url: 'https://nodes.kadena.ws/' },
  { name: 'Adoption Index', url: 'https://adoption.kadena.ws/' },
  { name: 'Kadena Earn', url: 'https://earn.kadena.ws/' },
  { name: 'Quantum-Safe Kadena', url: 'https://quantum.kadena.ws/' },
];
export const FAILS_TO_ALERT = 2;
const REMIND_MS = 6 * 60 * 60 * 1000;

/** SITES env: "Name|https://url|expected text, Name2|https://url2" (expected text optional). */
export function sitesFrom(env) {
  if (!env) return DEFAULT_SITES;
  return env.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [name, url, expect] = s.split('|').map((x) => x?.trim());
    return { name, url, ...(expect ? { expect } : {}) };
  }).filter((s) => s.name && /^https?:\/\//.test(s.url || ''));
}

/** One check: { ok, detail, ms }. */
export async function check(site, { fetcher = fetch, timeoutMs = 15000 } = {}) {
  const t0 = Date.now();
  try {
    const r = await fetcher(site.url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'KadenaNexus-SiteWatch/1.0' } });
    const ms = Date.now() - t0;
    if (r.status >= 400) return { ok: false, detail: `HTTP ${r.status}`, ms };
    if (site.expect) {
      const body = await r.text();
      if (!body.includes(site.expect)) return { ok: false, detail: 'answered, but not with the expected page', ms };
    }
    return { ok: true, detail: `HTTP ${r.status}`, ms };
  } catch (e) {
    return { ok: false, detail: e?.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000} s` : (e?.cause?.code || e?.message || 'connection failed'), ms: Date.now() - t0 };
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

/** One round. state: { [url]: { fails, down, since, lastAlert } }. Returns { state, emails: [{subject, html, text}] }. */
export async function runSites({ sites, state = {}, now = Date.now(), checker = check }) {
  const results = await Promise.all(sites.map(async (s) => ({ s, r: await checker(s) })));
  const next = {}, down = [], back = [], still = [];
  for (const { s, r } of results) {
    const p = state[s.url] || { fails: 0, down: false };
    if (r.ok) {
      if (p.down) back.push({ s, r, was: now - (p.since || now) });
      next[s.url] = { fails: 0, down: false };
    } else {
      const fails = (p.fails || 0) + 1;
      if (!p.down && fails >= FAILS_TO_ALERT) {
        down.push({ s, r });
        next[s.url] = { fails, down: true, since: now - (fails - 1) * 5 * 60 * 1000, lastAlert: now, detail: r.detail };
      } else if (p.down && now - (p.lastAlert || 0) >= REMIND_MS) {
        still.push({ s, r, was: now - (p.since || now) });
        next[s.url] = { ...p, fails, lastAlert: now, detail: r.detail };
      } else {
        next[s.url] = { ...p, fails, detail: r.detail };
      }
    }
  }
  const emails = [];
  const row = (s, text) => `<tr><td style="padding:10px 14px;border-bottom:1px solid #e3e8ef"><b>${esc(s.name)}</b><br><a href="${esc(s.url)}" style="color:#0077aa">${esc(s.url)}</a><div style="font:13px sans-serif;color:#4F6B76;margin-top:4px">${esc(text)}</div></td></tr>`;
  const mail = (subject, color, title, rows, lines) => ({
    subject,
    html: `<div style="max-width:560px;margin:auto;border:1px solid #d0dae8;border-radius:10px;overflow:hidden;font-family:sans-serif">
      <div style="background:${color};color:#fff;padding:14px 16px;font:700 15px sans-serif">${esc(title)}</div>
      <table style="width:100%;border-collapse:collapse">${rows}</table>
      <div style="padding:12px 16px;font:12px sans-serif;color:#6b7fa0">Kadena Nexus site watch · checked every 5 minutes</div></div>`,
    text: `${title}\n\n${lines.join('\n')}`,
  });
  if (down.length) emails.push(mail(
    `[Down] ${down.map((d) => d.s.name).join(', ')}`, '#C62828', `${down.length === 1 ? 'A site is' : `${down.length} sites are`} not answering`,
    down.map(({ s, r }) => row(s, `${r.detail} · failed ${FAILS_TO_ALERT} checks in a row`)).join(''),
    down.map(({ s, r }) => `${s.name} (${s.url}): ${r.detail}`)));
  if (still.length) emails.push(mail(
    `[Still down] ${still.map((d) => d.s.name).join(', ')}`, '#E2710A', 'Still not answering',
    still.map(({ s, r, was }) => row(s, `${r.detail} · down for ${ago(was)}`)).join(''),
    still.map(({ s, r, was }) => `${s.name} (${s.url}): ${r.detail}, down for ${ago(was)}`)));
  if (back.length) emails.push(mail(
    `[Back up] ${back.map((d) => d.s.name).join(', ')}`, '#2E7D32', `Back up`,
    back.map(({ s, r, was }) => row(s, `${r.detail} in ${r.ms} ms · was down about ${ago(was)}`)).join(''),
    back.map(({ s, was }) => `${s.name} (${s.url}) is answering again after about ${ago(was)}`)));
  return { state: next, emails, summary: results.map(({ s, r }) => `${r.ok ? 'up' : 'DOWN'} ${s.name} ${r.detail} ${r.ms}ms`) };
}
