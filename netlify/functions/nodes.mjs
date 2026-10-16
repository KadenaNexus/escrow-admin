// GET /api/nodes – the latest node crawl (see node-crawl.mjs), public and read-only, for nodes.kadena.ws.
import { getStore } from '@netlify/blobs';
import { publicView } from '../../lib/nodes.mjs';

const headers = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'cache-control': 'public, max-age=60',
};

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...headers, 'access-control-allow-methods': 'GET' } });
  const state = await getStore('node-crawl').get('state', { type: 'json' });
  if (!state) return new Response(JSON.stringify({ success: false, error: 'first crawl not finished yet', count: 0, data: [] }), { status: 503, headers });
  return new Response(JSON.stringify(publicView(state)), { headers });
};

export const config = { path: '/api/nodes' };
