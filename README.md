# Kadena Nexus – P2P Escrow Admin

Admin dashboard and email alerts for the `free.p2p-escrow-v10` contract on Kadena chain 1.

- `public/index.html` – the live dashboard (reads the chain directly in the browser).
- `netlify/functions/escrow-watch.mjs` – runs every 5 minutes on Netlify and emails when an escrow becomes **FUNDED**, **COMPLETED** or **DISPUTED**.
- `lib/watch.mjs` – the watcher logic (chain query, change detection, email content).

Nothing secret is stored in this repository. Keys live in Netlify environment variables.

## Environment variables (Netlify → Project configuration → Environment variables)

| Name | Required | Value |
|---|---|---|
| `RESEND_API_KEY` | yes | API key from resend.com (starts with `re_`) |
| `NOTIFY_EMAIL` | yes | Where alerts go. Until a domain is verified in Resend, this must be the email you signed up to Resend with. Several addresses can be comma separated after verification. |
| `EMAIL_FROM` | no | Sender, e.g. `Kadena Escrow <alerts@kadena.ws>` once kadena.ws is verified in Resend. Default: `onboarding@resend.dev`. |
| `DASHBOARD_URL` | no | Link used in emails. Default: this Netlify site's URL. |

## How it behaves

- First run: saves the current state of every escrow and sends a "Notifications are on" email.
- Every 5 minutes after that: compares with the saved state and sends one email listing any escrow that moved into FUNDED, COMPLETED or DISPUTED (disputes listed first). No change, no email.
- If the email fails, the state is not saved, so the alert is retried on the next run.
- If the chain cannot be reached for 30 minutes, one warning email is sent.
- State is kept in Netlify Blobs (store `escrow-watch`).

To reset (resend the "Notifications are on" email), delete the `snapshot` entry in Netlify → Blobs → `escrow-watch`.

License: MIT
