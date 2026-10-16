# Kadena Nexus – P2P Escrow Admin

Admin dashboard and email alerts for the `free.p2p-escrow-v10` contract on Kadena chain 1.

- `public/index.html` – the live dashboard (reads the chain directly in the browser).
- `netlify/functions/escrow-watch.mjs` – runs every 5 minutes on Netlify and emails when an escrow becomes **FUNDED**, **COMPLETED** or **DISPUTED**.
- `lib/watch.mjs` – the watcher logic (chain query, change detection, email content).
- `netlify/functions/site-watch.mjs` + `lib/sites.mjs` – every 5 minutes checks that each Kadena Nexus site answers (Marketplace page and server, kadena.ws, Kadena Devs, Network Monitor, Adoption Index, Kadena Earn, Quantum-Safe Kadena). Emails **[Down]** after 2 failed checks in a row (about 10 minutes), **[Still down]** every 6 hours, and **[Back up]** when it answers again. Tests: `node --test lib/sites.test.mjs`.
- `netlify/functions/node-crawl.mjs` + `lib/nodes.mjs` – every 10 minutes checks the public Kadena nodes, starting from our Jeddah node (`193.122.85.1:1789`) and the peers each node reports, and places them on the map. For each node it records software version, peer count, average response time and uptime. `netlify/functions/nodes.mjs` serves the result at **`/api/nodes`** (public, read-only) for the Network Monitor at nodes.kadena.ws. Replaces the denascan.com crawler. Tests: `node --test lib/nodes.test.mjs`.

Nothing secret is stored in this repository. Keys live in Netlify environment variables.

## Environment variables (Netlify → Project configuration → Environment variables)

| Name | Required | Value |
|---|---|---|
| `RESEND_API_KEY` | yes | API key from resend.com (starts with `re_`) |
| `NOTIFY_EMAIL` | yes | Where alerts go. Until a domain is verified in Resend, this must be the email you signed up to Resend with. Several addresses can be comma separated after verification. |
| `EMAIL_FROM` | no | Sender, e.g. `Kadena Escrow <alerts@kadena.ws>` once kadena.ws is verified in Resend. Default: `onboarding@resend.dev`. |
| `DASHBOARD_URL` | no | Link used in emails. Default: this Netlify site's URL. |
| `SITE_WATCH_EMAIL` | no | Where site-down alerts go. Default: `NOTIFY_EMAIL`. |
| `NODE_SEEDS` | no | Extra node addresses for the crawler to start from, comma separated `host:port`. |
| `SITES` | no | Replaces the list of checked sites: `Name|https://url|expected text, Name2|https://url2` (expected text optional). |

## How it behaves

- First run: saves the current state of every escrow and sends a "Notifications are on" email.
- Every 5 minutes after that: compares with the saved state and sends one email listing any escrow that moved into FUNDED, COMPLETED or DISPUTED (disputes listed first). No change, no email.
- If the email fails, the state is not saved, so the alert is retried on the next run.
- If the chain cannot be reached for 30 minutes, one warning email is sent.
- State is kept in Netlify Blobs (store `escrow-watch`).

To reset (resend the "Notifications are on" email), delete the `snapshot` entry in Netlify → Blobs → `escrow-watch`.

License: MIT
