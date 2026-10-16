// Netlify scheduled function: every 10 minutes, checks the public Kadena nodes, starting from our Jeddah node
// and the peers it knows (lib/nodes.mjs). The result is kept in Netlify Blobs and served by nodes.mjs at /api/nodes,
// which feeds nodes.kadena.ws. NODE_SEEDS (comma-separated host:port) adds extra addresses to start from.
import { getStore } from '@netlify/blobs';
import { crawl, SEEDS } from '../../lib/nodes.mjs';

export default async () => {
  const blobs = getStore('node-crawl');
  const state = (await blobs.get('state', { type: 'json' })) || {};
  const extra = String(process.env.NODE_SEEDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const { state: next, summary } = await crawl({ state, seeds: [...SEEDS, ...extra] });
  await blobs.setJSON('state', next);
  console.log(JSON.stringify(summary));
  return new Response(JSON.stringify(summary), { headers: { 'content-type': 'application/json' } });
};

export const config = { schedule: '*/10 * * * *' };
