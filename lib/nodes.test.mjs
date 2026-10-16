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
