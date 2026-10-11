// Netlify scheduled function: checks the escrow contract every 5 minutes
// and emails when an escrow becomes FUNDED, COMPLETED or DISPUTED.
import { getStore } from '@netlify/blobs';
import { run, sendResend } from '../../lib/watch.mjs';

export default async () => {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL;
  if (!apiKey || !to) {
    console.error('Missing RESEND_API_KEY or NOTIFY_EMAIL environment variable');
    return new Response('not configured', { status: 500 });
  }
  const blobs = getStore('escrow-watch');
  const store = {
    get: (key) => blobs.get(key, { type: 'json' }),
    set: (key, value) => blobs.setJSON(key, value),
  };
  const from = process.env.EMAIL_FROM || 'Kadena Escrow <onboarding@resend.dev>';
  const dashboardUrl = process.env.DASHBOARD_URL || process.env.URL || 'https://fluffy-hummingbird-d7ff3d.netlify.app';
  const result = await run({ store, dashboardUrl, send: (msg) => sendResend({ apiKey, from, to, ...msg }) });
  console.log(JSON.stringify(result));
  return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
};

export const config = { schedule: '*/5 * * * *' };
