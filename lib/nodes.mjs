/* ---------- Kadena node crawler (Kadena Nexus) ----------
 * Finds public Chainweb nodes and checks each one, replacing the denascan.com crawler for nodes.kadena.ws.
 * Runs every 10 minutes (netlify/functions/node-crawl.mjs); the result is served at /api/nodes in the same shape
 * as the old source, so the Network Monitor page only needed a new URL.
 *
 * One round:
 *  1. Start from our own node in Jeddah, the nodes we already know, and a list of addresses found before.
 *  2. Ask each node for its cut (GET /chainweb/0.0/mainnet01/cut): answering = reachable, cut height = how far
 *     along it is. Nodes use self-signed certificates, so the certificate is not checked; only public data is read.
 *  3. Ask up to PEER_ASK reachable nodes for their peers (GET .../cut/peer) and check the new ones too.
 *  4. Place new IPs on the map once (ip-api.com, cached).
 *  Nodes not reached for 7 days are dropped from the list.
 */
import https from 'node:https';
import { lookup } from 'node:dns/promises';

export const HOME = '193.122.85.1:1789';           // Kadena Nexus node, Jeddah
export const SEEDS = [
  '108.129.174.164:1789',
  '109.123.242.95:1789',
  '109.151.123.230:1789',
  '13.222.112.52:1789',
  '13.231.115.64:1789',
  '169.58.34.67:1789',
  '18.143.65.14:1789',
  '18.182.49.196:1789',
  '195.201.194.100:1789',
  '45.84.138.87:1789',
  '47.242.39.242:8899',
  '47.242.47.224:8443',
  '47.243.248.96:7034',
  '47.243.65.176:8899',
  '47.245.58.54:1789',
  '47.253.46.121:8443',
  '47.76.83.4:7034',
  '49.12.83.223:1789',
  '5.39.57.12:31350',
  '5.39.57.13:31350',
  '5.39.57.14:31350',
  '52.195.188.185:1789',
  '52.68.230.198:1789',
  '52.69.153.140:1789',
  '54.151.191.19:1789',
  '54.199.156.170:8443',
  '54.250.60.181:64382',
  '54.36.120.70:4430',
  '54.82.99.223:1789',
  '57.128.183.27:1789',
  '63.32.43.199:1789',
  '63.33.193.65:1789',
  '8.209.243.29:8443',
  '8.216.49.9:1789',
  '8.218.157.232:8443',
  '8.219.192.89:8443',
  '8.219.59.175:8443',
  '86.104.252.61:1789',
  '88.18.205.112:1789',
  'amazingthings.diskstation.me:43443',
  'bytales.duckdns.org:1789',
  'ca-1.chainweb-community.org:443',
  'chainweb.chaddex.com:443',
  'fr-1.chainweb-community.org:443',
  'hetzner-eu-13-58.poolmon.net:4443',
  'hetzner-eu-91-233.poolmon.net:4443',
  'nl-1.chainweb-community.org:443',
  'ovh-us-22-156.poolmon.net:4443',
  'pl-1.chainweb-community.org:443',
  'pl-2.chainweb-community.org:443',
];
const NET = 'mainnet01';
const TIMEOUT_MS = 4000;
const CONCURRENCY = 24;
const PEER_ASK = 12;
const MAX_NODES = 300;
const KEEP_MS = 7 * 24 * 3600 * 1000;

const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });

/** GET JSON from a node over HTTPS (self-signed allowed). Resolves { ok, status, json, ms } or { ok:false, error }. */
export function nodeGet(addr, path, timeoutMs = TIMEOUT_MS) {
  const [host, port] = splitAddr(addr);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const req = https.request({ host, port, path, method: 'GET', agent, timeout: timeoutMs,
      headers: { accept: 'application/json', 'user-agent': 'KadenaNexus-NodeCrawler/1.0' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(new Error('too large')); });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(body); } catch { /* not json */ }
        resolve({ ok: res.statusCode === 200 && json !== null, status: res.statusCode, json, ms: Date.now() - t0 });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, error: e.message, ms: Date.now() - t0 }));
    req.end();
  });
}

export function splitAddr(addr) {
  const i = String(addr).lastIndexOf(':');
  return [addr.slice(0, i), Number(addr.slice(i + 1))];
}
const validAddr = (a) => /^[A-Za-z0-9.-]{1,253}:\d{1,5}$/.test(a) && !/^(10|127|192\.168|169\.254|0)\./.test(a) && !/^172\.(1[6-9]|2\d|3[01])\./.test(a) && !/^localhost:/i.test(a);

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

/** Peer addresses from a node's /cut/peer answer. */
export function peersOf(json) {
  const items = Array.isArray(json?.items) ? json.items : Array.isArray(json) ? json : [];
  return items.map((p) => p?.address && `${p.address.hostname}:${p.address.port}`).filter((a) => a && validAddr(a));
}

const isIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');
const resolveHost = (h) => Promise.race([lookup(h, { family: 4 }).then((r) => r.address), new Promise((_, no) => setTimeout(() => no(new Error('dns timeout')), 3000))]);

/**
 * Geolocation for new hosts, batched (ip-api.com, free tier, http). Returns { host: { country, city, lat, lng, isp, org } }.
 * ip-api's batch only takes IP addresses, so nodes listed by name (fr-1.chainweb-community.org, ...) are looked up in DNS first.
 */
export async function geolocate(hosts, fetcher = fetch, resolve = resolveHost) {
  const out = {};
  const ipOf = {};
  await Promise.all(hosts.map(async (h) => { try { ipOf[h] = isIp(h) ? h : await resolve(h); } catch { /* try again next round */ } }));
  const named = Object.keys(ipOf);
  for (let i = 0; i < named.length; i += 100) {
    const batch = named.slice(i, i + 100);
    try {
      const r = await fetcher('http://ip-api.com/batch?fields=status,country,city,regionName,lat,lon,isp,org,timezone,query', {
        method: 'POST', body: JSON.stringify(batch.map((h) => ipOf[h])), headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const list = await r.json();
      list.forEach((g, k) => { if (g && g.status === 'success') out[batch[k]] = { country: g.country, city: g.city, region: g.regionName, lat: g.lat, lng: g.lon, isp: g.isp, org: g.org, timezone: g.timezone }; });
    } catch { /* try again next round */ }
  }
  return out;
}

/**
 * One crawl round. state: { nodes: { addr: {...} }, geo: { host: {...} } }.
 * get(addr, path) and geo(hosts) can be injected for tests. Returns the new state and a summary.
 */
export async function crawl({ state = {}, now = Date.now(), get = nodeGet, geo = geolocate, seeds = SEEDS, home = HOME, budgetMs = 22000 } = {}) {
  const t0 = Date.now();
  const nodes = { ...(state.nodes || {}) };
  const geoCache = { ...(state.geo || {}) };
  const queue = [...new Set([home, ...Object.keys(nodes), ...seeds])].filter(validAddr).slice(0, MAX_NODES);
  const seen = new Set(queue);
  const results = {};

  const check = async (addr) => {
    const r = await get(addr, `/chainweb/0.0/${NET}/cut`);
    const height = r.ok && Number.isFinite(Number(r.json?.height)) ? Number(r.json.height) : null;
    results[addr] = { ok: r.ok && height !== null, height, ms: r.ms, error: r.ok ? null : (r.error || `HTTP ${r.status}`) };
  };
  await pool(queue, CONCURRENCY, check);

  // discover: ask reachable nodes (our own first) for their peers, check the new ones
  if (Date.now() - t0 < budgetMs) {
    const askers = [home, ...queue.filter((a) => a !== home)].filter((a) => results[a]?.ok).slice(0, PEER_ASK);
    const found = new Set();
    await pool(askers, CONCURRENCY, async (a) => {
      const r = await get(a, `/chainweb/0.0/${NET}/cut/peer?limit=100`);
      if (r.ok) for (const p of peersOf(r.json)) if (!seen.has(p)) found.add(p);
    });
    const fresh = [...found].slice(0, Math.max(0, MAX_NODES - seen.size));
    fresh.forEach((a) => seen.add(a));
    if (fresh.length && Date.now() - t0 < budgetMs) await pool(fresh, CONCURRENCY, check);
  }

  // merge into the long-lived list
  for (const [addr, r] of Object.entries(results)) {
    const p = nodes[addr] || { firstSeen: null, lastSeen: null, probes: 0, okProbes: 0, failures: 0 };
    nodes[addr] = {
      ...p,
      probes: p.probes + 1, okProbes: p.okProbes + (r.ok ? 1 : 0), failures: r.ok ? 0 : p.failures + 1,
      lastProbe: now, lastSeen: r.ok ? now : p.lastSeen, firstSeen: p.firstSeen || (r.ok ? now : null),
      height: r.ok ? r.height : p.height ?? null, ms: r.ok ? r.ms : p.ms ?? null, error: r.error,
      home: addr === home,
    };
  }
  // forget addresses never reached, or not reached for a week (the seed list keeps old ones coming back to try)
  for (const [addr, n] of Object.entries(nodes)) {
    if (addr === home) continue;
    if (!n.lastSeen ? n.probes >= 6 * 24 * 3 : now - n.lastSeen > KEEP_MS) delete nodes[addr];
  }

  const hosts = [...new Set(Object.keys(nodes).map((a) => splitAddr(a)[0]))].filter((h) => !geoCache[h]);
  if (hosts.length) Object.assign(geoCache, await geo(hosts));

  const reachable = Object.values(results).filter((r) => r.ok).length;
  return { state: { nodes, geo: geoCache, crawledAt: now, reachable }, summary: { checked: Object.keys(results).length, reachable, known: Object.keys(nodes).length, ms: Date.now() - t0 } };
}

/** The public answer, in the shape the Network Monitor already reads ({ success, count, data: [...] }). */
export function publicView(state, now = Date.now()) {
  const nodes = state.nodes || {}, geo = state.geo || {};
  const iso = (t) => (t ? new Date(t).toISOString() : null);
  const data = Object.entries(nodes)
    .filter(([, n]) => n.lastSeen)                       // only nodes that have answered at least once
    .map(([addr, n]) => {
      const [host, port] = splitAddr(addr);
      const g = geo[host] || {};
      // answered in the latest check, or within the last 30 minutes if this round ran out of time before reaching it
      const active = n.failures === 0 && (state.crawledAt || now) - n.lastSeen <= 30 * 60 * 1000;
      return {
        name: addr, coordinate: g.lat != null ? { lat: g.lat, lng: g.lng } : null, city: g.city || null, country: g.country || null,
        comment: n.home ? 'Kadena Nexus node' : null,
        metadata: {
          isp: g.isp || null, org: g.org || null, region: g.region || null, timezone: g.timezone || null,
          hostname: host, port, status: active ? 'active' : 'dead', home: !!n.home,
          first_seen: iso(n.firstSeen), last_seen: iso(n.lastSeen), last_probe: iso(n.lastProbe),
          cut_height: n.height || 0, response_time_ms: n.ms, consecutive_failures: n.failures,
          total_probes: n.probes, successful_probes: n.okProbes, network_id: NET,
        },
      };
    });
  return { success: true, source: 'Kadena Nexus node crawler', crawled_at: iso(state.crawledAt), count: data.length, data };
}
