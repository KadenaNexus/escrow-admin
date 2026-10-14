// Netlify scheduled function: every 5 minutes, checks that each Kadena Nexus site answers and emails when one
// goes down (2 failed checks in a row), every 6 hours while it stays down, and when it is back (lib/sites.mjs).
// Uses the same RESEND_API_KEY / NOTIFY_EMAIL / EMAIL_FROM as escrow-watch. SITES overrides the list.
import { getStore } from '@netlify/blobs';
import { sendResend } from '../../lib/watch.mjs';
import { runSites, sitesFrom } from '../../lib/sites.mjs';

export default async () => {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.SITE_WATCH_EMAIL || process.env.NOTIFY_EMAIL;
  if (!apiKey || !to) {
    console.error('Missing RESEND_API_KEY or NOTIFY_EMAIL environment variable');
    return new Response('not configured', { status: 500 });
  }
  const blobs = getStore('site-watch');
  const state = (await blobs.get('state', { type: 'json' })) || {};
  const from = process.env.EMAIL_FROM || 'Kadena Escrow <onboarding@resend.dev>';
  const { state: next, emails, summary } = await runSites({ sites: sitesFrom(process.env.SITES), state });
  for (const m of emails) {
    try { await sendResend({ apiKey, from, to, ...m }); }
    catch (e) {
      // keep the old state, so the same alert is tried again in 5 minutes
      console.error('site-watch email failed:', e.message);
      return new Response('email failed', { status: 502 });
    }
  }
  await blobs.setJSON('state', next);
  console.log(JSON.stringify({ emails: emails.map((m) => m.subject), summary }));
  return new Response(JSON.stringify({ emails: emails.length, summary }), { headers: { 'content-type': 'application/json' } });
};

export const config = { schedule: '*/5 * * * *' };
