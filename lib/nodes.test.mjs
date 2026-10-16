import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crawl, publicView, peersOf, HOME } from './nodes.mjs';

const cut = (h) => ({ ok: true, status: 200, json: { height: h, hashes: {} }, ms: 50 });
const down = { ok: false, error: 'timeout', ms: 4000 };
const noGeo = async () => ({});

function fakeNet(map) {
  // map: addr -> { height?, peers? }   (missing = unreachable)
  return async (addr, path) => {
    const n = map[addr];
    if (!n) return down;
    if (path.includes('/cut/peer')) return { ok: true, status: 200, json: { items: (n.peers || []).map((a) => { const [hostname, port] = a.split(':'); return { id: null, address: { hostname, port: Number(port) } }; }) }, ms: 40 };
    return cut(n.height);
  };
}

test('peersOf reads /cut/peer and skips private addresses', () => {
  const json = { items: [
    { address: { hostname: '8.8.4.4', port: 1789 } },
    { address: { hostname: '10.0.0.5', port: 1789 } },
    { address: { hostname: '192.168.1.2', port: 443 } },
    { address: { hostname: 'node.example.org', port: 443 } },
  ] };
  assert.deepEqual(peersOf(json), ['8.8.4.4:1789', 'node.example.org:443']);
});

test('crawl checks our node and seeds, then finds new peers through them', async () => {
  const get = fakeNet({
    [HOME]: { height: 1000, peers: ['5.5.5.5:1789', '6.6.6.6:443'] },
    '1.1.1.1:1789': { height: 999 },
    '5.5.5.5:1789': { height: 1001 },
    // 6.6.6.6 is listed as a peer but does not answer
  });
  const { state, summary } = await crawl({ get, geo: noGeo, seeds: ['1.1.1.1:1789', '2.2.2.2:1789'], now: 1e12 });
  assert.equal(summary.reachable, 3);
  assert.equal(summary.checked, 5);
  assert.equal(state.nodes['5.5.5.5:1789'].height, 1001);
  assert.equal(state.nodes[HOME].home, true);
  const view = publicView(state, 1e12);
  // only nodes that answered at least once are published
  assert.deepEqual(view.data.map((d) => d.name).sort(), ['1.1.1.1:1789', '193.122.85.1:1789', '5.5.5.5:1789']);
  assert.ok(view.data.every((d) => d.metadata.status === 'active'));
  assert.equal(view.data.find((d) => d.metadata.home).comment, 'Kadena Nexus node');
});

test('a node that stops answering turns dead but keeps its last height, then is dropped after 7 days', async () => {
  const t = 1e12;
  let { state } = await crawl({ get: fakeNet({ [HOME]: { height: 10 }, '1.1.1.1:1789': { height: 10 } }), geo: noGeo, seeds: ['1.1.1.1:1789'], now: t });
  ({ state } = await crawl({ state, get: fakeNet({ [HOME]: { height: 12 } }), geo: noGeo, seeds: [], now: t + 600e3 }));
  let n = publicView(state).data.find((d) => d.name === '1.1.1.1:1789');
  assert.equal(n.metadata.status, 'dead');
  assert.equal(n.metadata.cut_height, 10);
  assert.equal(n.metadata.consecutive_failures, 1);
  assert.equal(n.metadata.total_probes, 2);
  assert.equal(n.metadata.successful_probes, 1);
  ({ state } = await crawl({ state, get: fakeNet({ [HOME]: { height: 99 } }), geo: noGeo, seeds: [], now: t + 8 * 864e5 }));
  assert.equal(state.nodes['1.1.1.1:1789'], undefined);
  assert.ok(state.nodes[HOME], 'our own node is never dropped');
});

test('geolocation is asked once per host and copied into the answer', async () => {
  let asked = [];
  const geo = async (hosts) => { asked.push(...hosts); return Object.fromEntries(hosts.map((h) => [h, { country: 'Saudi Arabia', city: 'Jeddah', lat: 21.5, lng: 39.2, isp: 'X', org: 'Y' }])); };
  const get = fakeNet({ [HOME]: { height: 1 } });
  let { state } = await crawl({ get, geo, seeds: [], now: 1 });
  ({ state } = await crawl({ state, get, geo, seeds: [], now: 2 }));
  assert.deepEqual(asked, ['193.122.85.1']);
  const d = publicView(state).data[0];
  assert.equal(d.city, 'Jeddah');
  assert.deepEqual(d.coordinate, { lat: 21.5, lng: 39.2 });
});

test('a non-JSON or error answer counts as unreachable', async () => {
  const get = async () => ({ ok: false, status: 502, json: null, ms: 10 });
  const { state, summary } = await crawl({ get, geo: noGeo, seeds: [], now: 1 });
  assert.equal(summary.reachable, 0);
  assert.equal(state.nodes[HOME].error, 'HTTP 502');
  assert.equal(publicView(state).count, 0);
});

test('nodes listed by name are looked up in DNS before geolocation', async () => {
  const { geolocate } = await import('./nodes.mjs');
  let sent;
  const fetcher = async (_url, opts) => { sent = JSON.parse(opts.body); return { ok: true, json: async () => sent.map((ip) => ({ status: 'success', country: 'France', city: 'Paris', lat: 48.8, lon: 2.3, isp: 'OVH', org: 'OVH' })) }; };
  const resolve = async (h) => { if (h === 'gone.example.org') throw new Error('ENOTFOUND'); return '51.15.1.2'; };
  const out = await geolocate(['fr-1.chainweb-community.org', '45.84.138.87', 'gone.example.org'], fetcher, resolve);
  assert.deepEqual(sent.sort(), ['45.84.138.87', '51.15.1.2']);
  assert.equal(out['fr-1.chainweb-community.org'].city, 'Paris');
  assert.equal(out['45.84.138.87'].country, 'France');
  assert.equal(out['gone.example.org'], undefined);
});

test('details: version from header or /info, peer count across pages, chain heights, uptime and average latency', async () => {
  const peerPage = (from, n, next) => ({ ok: true, status: 200, ms: 30, json: { items: Array.from({ length: n }, (_, i) => ({ address: { hostname: `7.7.${from}.${i}`, port: 1789 } })), next } });
  const calls = [];
  const get = async (addr, path) => {
    calls.push(`${addr} ${path}`);
    if (addr === HOME) {
      if (path.endsWith('/cut')) return { ok: true, status: 200, ms: 100, headers: { 'x-chainweb-node-version': '2.31.1' }, json: { height: 40, hashes: { 0: { height: 1 }, 1: { height: 3 } } } };
      if (path.includes('/cut/peer') && !path.includes('next=')) return peerPage(1, 100, 'inclusive:abc');
      if (path.includes('/cut/peer')) return peerPage(2, 20, null);
    }
    if (addr === '1.1.1.1:1789') {
      if (path.endsWith('/cut')) return { ok: true, status: 200, ms: 300, headers: {}, json: { height: 40, hashes: {} } };
      if (path === '/info') return { ok: true, status: 200, ms: 30, json: { nodeVersion: 'mainnet01', nodePackageVersion: '2.30' } };
      if (path.includes('/cut/peer')) return { ok: false, error: 'timeout' };
    }
    return { ok: false, error: 'timeout' };
  };
  let { state } = await crawl({ get, geo: async () => ({}), seeds: ['1.1.1.1:1789'], now: 1 });
  let v = Object.fromEntries(publicView(state).data.map((d) => [d.name, d.metadata]));
  assert.equal(v[HOME].package_version, '2.31.1');
  assert.equal(v[HOME].peer_count, 120);
  assert.equal(v[HOME].peer_count_more, false);
  assert.deepEqual([v[HOME].num_chains, v[HOME].min_chain_height, v[HOME].max_chain_height], [2, 1, 3]);
  assert.equal(v['1.1.1.1:1789'].package_version, '2.30');          // from /info
  assert.equal(v['1.1.1.1:1789'].peer_count, null);
  assert.ok(calls.includes(`${HOME} /chainweb/0.0/mainnet01/cut/peer?limit=100&next=inclusive%3Aabc`));
  assert.ok(!calls.includes(`${HOME} /info`), 'no /info call when the header has the version');

  // second round 10 minutes later: /info is not asked again, version kept, latency averaged, uptime counted
  calls.length = 0;
  ({ state } = await crawl({ state, get, geo: async () => ({}), seeds: ['1.1.1.1:1789'], now: 600e3 }));
  v = Object.fromEntries(publicView(state).data.map((d) => [d.name, d.metadata]));
  assert.ok(!calls.includes('1.1.1.1:1789 /info'));
  assert.equal(v['1.1.1.1:1789'].package_version, '2.30');
  assert.equal(v[HOME].avg_response_time_ms, 100);
  assert.equal(v[HOME].uptime_pct, 100);
  // the 120 peers found through our node were checked as new addresses (none answered)
  assert.equal(state.nodes['7.7.1.0:1789'].probes, 2);
  assert.equal(v['7.7.1.0:1789'], undefined);
});

test('a bad version header is ignored', async () => {
  const { versionOf } = await import('./nodes.mjs');
  assert.equal(versionOf({ 'x-chainweb-node-version': '2.31.1' }), '2.31.1');
  assert.equal(versionOf({ 'x-chainweb-node-version': '<script>' }), null);
  assert.equal(versionOf({}), null);
});

test('a round stops starting new checks when its time budget is spent, our node first', async () => {
  const order = [];
  const get = async (addr, path) => { if (path.endsWith('/cut')) order.push(addr); await new Promise((r) => setTimeout(r, 30)); return { ok: false, error: 'timeout' }; };
  const seeds = Array.from({ length: 200 }, (_, i) => `9.9.${i >> 8}.${i & 255}:1789`);
  const { summary } = await crawl({ get, geo: async () => ({}), seeds, now: 1, budgetMs: 50 });
  assert.equal(order[0], HOME);
  assert.ok(summary.checked < 201, `checked ${summary.checked}`);
});
