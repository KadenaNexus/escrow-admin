// node --test lib/sites.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSites, check, sitesFrom, DEFAULT_SITES } from './sites.mjs';

const A = { name: 'Marketplace', url: 'https://m.example/' }, B = { name: 'Devs', url: 'https://d.example/' };
const checker = (down) => async (s) => (down.includes(s.url) ? { ok: false, detail: 'HTTP 502', ms: 30 } : { ok: true, detail: 'HTTP 200', ms: 20 });

test('one failed check does not alert; the second does; recovery is announced once', async () => {
  let state = {}, now = 0;
  let r = await runSites({ sites: [A, B], state, now, checker: checker([A.url]) });
  assert.equal(r.emails.length, 0, 'a single slow or failed answer is ignored');
  state = r.state; now += 5 * 60e3;
  r = await runSites({ sites: [A, B], state, now, checker: checker([A.url]) });
  assert.deepEqual(r.emails.map((m) => m.subject), ['[Down] Marketplace']);
  assert.match(r.emails[0].text, /HTTP 502/);
  state = r.state; now += 5 * 60e3;
  r = await runSites({ sites: [A, B], state, now, checker: checker([A.url]) });
  assert.equal(r.emails.length, 0, 'no repeat every 5 minutes');
  state = r.state; now += 6 * 60 * 60e3;
  r = await runSites({ sites: [A, B], state, now, checker: checker([A.url]) });
  assert.deepEqual(r.emails.map((m) => m.subject), ['[Still down] Marketplace'], 'a reminder after 6 hours');
  state = r.state; now += 5 * 60e3;
  r = await runSites({ sites: [A, B], state, now, checker: checker([]) });
  assert.deepEqual(r.emails.map((m) => m.subject), ['[Back up] Marketplace']);
  state = r.state;
  r = await runSites({ sites: [A, B], state, now, checker: checker([]) });
  assert.equal(r.emails.length, 0);
});

test('a check fails on HTTP errors, wrong pages and timeouts', async () => {
  const res = (status, body = '') => async () => ({ status, text: async () => body });
  assert.equal((await check(A, { fetcher: res(200) })).ok, true);
  assert.equal((await check(A, { fetcher: res(503) })).ok, false);
  assert.equal((await check({ ...A, expect: 'P2P' }, { fetcher: res(200, '<title>Parked domain</title>') })).ok, false);
  assert.equal((await check({ ...A, expect: 'P2P' }, { fetcher: res(200, '<title>Kadena P2P Marketplace</title>') })).ok, true);
  // (the keep-alive timer stands in for a real socket, which keeps the process running while it waits)
  const slow = async (_u, o) => new Promise((_r, rej) => { const k = setTimeout(() => {}, 2000); o.signal.addEventListener('abort', () => { clearTimeout(k); rej(Object.assign(new Error('t'), { name: 'TimeoutError' })); }); });
  assert.match((await check(A, { fetcher: slow, timeoutMs: 50 })).detail, /no answer/);
});

test('SITES can replace the list', () => {
  assert.equal(sitesFrom('').length, DEFAULT_SITES.length);
  assert.deepEqual(sitesFrom('Shop|https://shop.example/|Buy, Bad|ftp://x'), [{ name: 'Shop', url: 'https://shop.example/', expect: 'Buy' }]);
});
