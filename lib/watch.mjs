// Core logic for the escrow email watcher (free.p2p-escrow-v10).
// Kept free of Netlify specifics so it can be tested locally.

export const CONTRACT = 'free.p2p-escrow-v10';
const CHAIN_ID = '1';
const NETWORK_ID = 'mainnet01';
const API_HOSTS = [
  'https://api.chainweb-community.org',
  'https://chainweb.chaddex.com',
  'https://api.chainweb.com',
];
// States that trigger an email.
export const WATCH = ['FUNDED', 'COMPLETED', 'DISPUTED'];
// After this many failed runs in a row (5 min apart = 30 min) send one alert.
const FAIL_ALERT_AFTER = 6;

/* ---------- BLAKE2b-256 for the Pact command hash ---------- */
function blake2b256(bytes) {
  const M64 = (1n << 64n) - 1n;
  const IV = [0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n, 0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n];
  const S = [[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],[14,10,4,8,9,15,13,6,1,12,0,2,11,7,5,3],[11,8,12,0,5,2,15,13,10,14,3,6,7,1,9,4],[7,9,3,1,13,12,11,14,2,6,5,10,4,0,15,8],[9,0,5,7,2,4,10,15,14,1,11,12,6,8,3,13],[2,12,6,10,0,11,8,3,4,13,7,5,15,14,1,9],[12,5,1,15,14,13,4,10,0,7,6,3,9,2,8,11],[13,11,7,14,12,1,3,9,5,0,15,4,8,6,2,10],[6,15,14,9,11,3,0,8,12,2,13,7,1,4,10,5],[10,2,8,4,7,6,1,5,15,11,9,14,3,12,13,0]];
  const rotr = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & M64;
  const h = IV.slice(); h[0] ^= 0x01010020n;
  const len = bytes.length; let t = 0n; const block = new Uint8Array(128);
  const compress = (last) => {
    const m = new Array(16);
    for (let i = 0; i < 16; i++) { let w = 0n; for (let j = 7; j >= 0; j--) w = (w << 8n) | BigInt(block[i * 8 + j]); m[i] = w; }
    const v = h.concat(IV); v[12] ^= t & M64; v[13] ^= (t >> 64n) & M64; if (last) v[14] ^= M64;
    const G = (a, b, c, d, x, y) => { v[a] = (v[a] + v[b] + x) & M64; v[d] = rotr(v[d] ^ v[a], 32); v[c] = (v[c] + v[d]) & M64; v[b] = rotr(v[b] ^ v[c], 24); v[a] = (v[a] + v[b] + y) & M64; v[d] = rotr(v[d] ^ v[a], 16); v[c] = (v[c] + v[d]) & M64; v[b] = rotr(v[b] ^ v[c], 63); };
    for (let r = 0; r < 12; r++) { const s = S[r % 10];
      G(0,4,8,12,m[s[0]],m[s[1]]); G(1,5,9,13,m[s[2]],m[s[3]]); G(2,6,10,14,m[s[4]],m[s[5]]); G(3,7,11,15,m[s[6]],m[s[7]]);
      G(0,5,10,15,m[s[8]],m[s[9]]); G(1,6,11,12,m[s[10]],m[s[11]]); G(2,7,8,13,m[s[12]],m[s[13]]); G(3,4,9,14,m[s[14]],m[s[15]]); }
    for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
  };
  let off = 0;
  while (len - off > 128) { block.set(bytes.subarray(off, off + 128)); t += 128n; compress(false); off += 128; }
  block.fill(0); block.set(bytes.subarray(off)); t += BigInt(len - off); compress(true);
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 8; j++) out[i * 8 + j] = Number((h[i] >> BigInt(8 * j)) & 0xffn);
  return Buffer.from(out).toString('base64url');
}

/* ---------- Chain access ---------- */
async function pactLocal(code, data = {}) {
  const ct = Math.floor(Date.now() / 1000);
  const cmd = JSON.stringify({ networkId: NETWORK_ID, payload: { exec: { code, data } }, signers: [], meta: { chainId: CHAIN_ID, sender: '', gasLimit: 1000000, gasPrice: 1e-8, ttl: 600, creationTime: ct }, nonce: `watch-${ct}` });
  const body = JSON.stringify({ cmd, hash: blake2b256(new TextEncoder().encode(cmd)), sigs: [] });
  let lastErr;
  for (const base of API_HOSTS) {
    try {
      const r = await fetch(`${base}/chainweb/0.0/${NETWORK_ID}/chain/${CHAIN_ID}/pact/api/v1/local?preflight=false&signatureVerification=false`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HTTP ${r.status} from ${base}`);
      const d = await r.json();
      if (d.result?.status !== 'success') throw new Error(`Pact error: ${d.result?.error?.message || 'unknown'}`);
      return d.result.data;
    } catch (e) {
      lastErr = e;
      if (String(e.message).startsWith('Pact error')) throw e; // same on every node
    }
  }
  throw new Error(`All Chainweb nodes failed: ${lastErr?.message}`);
}

const num = (x) => (x && typeof x === 'object' ? Number(x.int ?? x.decimal ?? 0) : Number(x || 0));

export async function fetchEscrows() {
  const code = `(map (lambda (id) (+ {"id":id} (${CONTRACT}.get-escrow id))) (${CONTRACT}.list-escrow-ids))`;
  const rows = await pactLocal(code);
  const out = {};
  for (const e of rows) {
    out[e.id] = { state: String(e.state || '').toUpperCase(), amount: num(e.amount), side: String(e.side || '').toUpperCase(), creator: e.creator || '', buyer: e.buyer || '' };
  }
  return out;
}

async function fetchPrice() {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=kadena&vs_currencies=usd', { signal: AbortSignal.timeout(4000) });
    return (await r.json())?.kadena?.usd ?? null;
  } catch { return null; }
}

/* ---------- Diff ---------- */
export function diff(prev, curr) {
  const events = [];
  for (const [id, e] of Object.entries(curr)) {
    const before = prev[id]?.state;
    if (e.state !== before && WATCH.includes(e.state)) events.push({ id, from: before || 'NEW', ...e });
  }
  // Disputes first, then funded, then completed.
  const rank = { DISPUTED: 0, FUNDED: 1, COMPLETED: 2 };
  return events.sort((a, b) => rank[a.state] - rank[b.state] || b.amount - a.amount);
}

/* ---------- Email content ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (a) => (a ? (a.startsWith('k:') ? a.slice(2) : a).replace(/^(.{6}).*(.{4})$/, '$1…$2') : '–');
const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 });
const COLOR = { DISPUTED: '#cc2200', FUNDED: '#1e6fb0', COMPLETED: '#00875a' };
const NOTE = {
  DISPUTED: 'Arbiter action needed: sign release or refund with the arbiter key.',
  FUNDED: 'KDA is now locked in the vault. Fiat payment window (T2, 4 h) has started.',
  COMPLETED: 'KDA released to the receiver. Trade closed.',
};

export function buildEmail(events, price, dashboardUrl) {
  const counts = ['DISPUTED', 'FUNDED', 'COMPLETED'].map((s) => [s, events.filter((e) => e.state === s).length]).filter(([, n]) => n);
  const top = events[0];
  const subject = events.length === 1
    ? `[Escrow] ${top.state}: ${fmt(top.amount)} KDA (${top.side})`
    : `[Escrow] ${counts.map(([s, n]) => `${n} ${s}`).join(', ')}`;
  const usd = (a) => (price ? ` (≈ $${(a * price).toFixed(2)})` : '');
  const rows = events.map((e) => `
    <tr><td style="padding:14px 16px;border-bottom:1px solid #e3e8ef">
      <div style="font:700 12px monospace;color:${COLOR[e.state]}">${e.state} <span style="color:#6b7fa0;font-weight:400">(was ${esc(e.from)})</span></div>
      <div style="font:700 16px sans-serif;color:#0f1923;margin:4px 0">${fmt(e.amount)} KDA${usd(e.amount)} · ${esc(e.side)}</div>
      <div style="font:12px monospace;color:#6b7fa0">${esc(e.id)}</div>
      <div style="font:12px monospace;color:#6b7fa0">creator ${esc(short(e.creator))} · buyer ${esc(short(e.buyer))}</div>
      <div style="font:13px sans-serif;color:#0f1923;margin-top:6px">${NOTE[e.state]}</div>
    </td></tr>`).join('');
  const html = `<div style="max-width:560px;margin:auto;border:1px solid #d0dae8;border-radius:10px;overflow:hidden">
    <div style="background:#0e1520;color:#e2eaf5;padding:14px 16px;font:700 14px monospace">Kadena Nexus · P2P Escrow</div>
    <table style="width:100%;border-collapse:collapse">${rows}</table>
    <div style="padding:14px 16px;font:13px sans-serif"><a href="${esc(dashboardUrl)}" style="color:#0077aa">Open the dashboard</a></div></div>`;
  const text = events.map((e) => `${e.state} (was ${e.from}): ${fmt(e.amount)} KDA ${e.side}\n${e.id}\ncreator ${e.creator}\nbuyer ${e.buyer}\n${NOTE[e.state]}`).join('\n\n') + `\n\nDashboard: ${dashboardUrl}`;
  return { subject, html, text };
}

export async function sendResend({ apiKey, from, to, subject, html, text }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: to.split(',').map((s) => s.trim()).filter(Boolean), subject, html, text }),
  });
  if (!r.ok) throw new Error(`Resend HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

/* ---------- One run ---------- */
// store: { get(key) -> object|null, set(key, object) }
// send:  ({subject, html, text}) -> Promise
export async function run({ store, send, dashboardUrl }) {
  let curr;
  try {
    curr = await fetchEscrows();
  } catch (err) {
    const fails = ((await store.get('fails')) ?? 0) + 1;
    await store.set('fails', fails);
    if (fails === FAIL_ALERT_AFTER) {
      await send({
        subject: '[Escrow] Monitor cannot reach the Kadena chain',
        text: `The escrow watcher has failed ${fails} runs in a row (about 30 min).\nLast error: ${err.message}\nNo notifications are being sent until it recovers.`,
        html: `<p>The escrow watcher has failed ${fails} runs in a row (about 30 min).</p><p>Last error: <code>${esc(err.message)}</code></p><p>No notifications are being sent until it recovers.</p>`,
      }).catch(() => {});
    }
    return { ok: false, error: err.message, fails };
  }
  await store.set('fails', 0);

  const prev = await store.get('snapshot');
  if (!prev) {
    // First run: remember the current state and confirm by email.
    const n = Object.keys(curr).length;
    const counts = {};
    Object.values(curr).forEach((e) => (counts[e.state] = (counts[e.state] || 0) + 1));
    const summary = Object.entries(counts).map(([s, c]) => `${s}: ${c}`).join(', ');
    await send({
      subject: '[Escrow] Notifications are on',
      text: `Watching ${n} escrows on ${CONTRACT}.\n${summary}\n\nYou will get an email when an escrow becomes FUNDED, COMPLETED or DISPUTED. Checked every 5 minutes.\n\nDashboard: ${dashboardUrl}`,
      html: `<p>Watching <b>${n}</b> escrows on <code>${CONTRACT}</code>.<br>${esc(summary)}</p><p>You will get an email when an escrow becomes <b>FUNDED</b>, <b>COMPLETED</b> or <b>DISPUTED</b>. Checked every 5 minutes.</p><p><a href="${esc(dashboardUrl)}">Open the dashboard</a></p>`,
    });
    await store.set('snapshot', curr);
    return { ok: true, firstRun: true, escrows: n };
  }

  const events = diff(prev, curr);
  if (events.length) {
    const price = await fetchPrice();
    await send(buildEmail(events, price, dashboardUrl));
  }
  // Save only after the email went out, so a failed send is retried next run.
  await store.set('snapshot', curr);
  return { ok: true, escrows: Object.keys(curr).length, events: events.map((e) => `${e.id}:${e.from}->${e.state}`) };
}
