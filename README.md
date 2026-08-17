# Itinerary Agent

Reads trip requests from a Google Sheet, generates a day-by-day itinerary
using an Ollama LLM, renders it as a PDF, and emails it to the traveler.

**Active implementation: Google Apps Script** (`apps-script/Code.gs`), bound
directly to the "Trip Inquiries" sheet — see below. The original Netlify
function (`netlify/functions/`) is kept in the repo but is **not** the
deployed path; it's documented further down for reference.

## Why Apps Script instead of Netlify

The Netlify function needed a Google service account (with a downloadable
JSON key) to read/write the sheet. The Google Cloud organization we tried
to create that under enforces the `iam.disableServiceAccountKeyCreation`
org policy, which blocks all service account key creation org-wide — not
something fixable without an Org Policy Administrator on that Workspace
domain. Apps Script sidesteps this entirely: a script bound to the sheet
runs as the sheet's owner automatically, no service account or key needed.
It also has built-in `MailApp` for email (no Resend account needed) and a
6-30 minute execution window per run (vs. Netlify's 15 min background-function
limit, which itself required a paid plan).

**Tested locally** (via the equivalent Netlify code path against
`llama3:8b`): a single 4-day itinerary took ~3.5 minutes end-to-end (Ollama
generation dominates). Budget for several minutes per trip in Apps Script
too — same Ollama server, same generation cost.

## Important: Ollama hosting

Neither Netlify Functions nor Google Apps Script can run Ollama itself —
both are short-lived/serverless execution models, and Ollama needs a
persistent, always-running process with multi-GB model weights loaded in
memory. You need Ollama running somewhere that stays up continuously and
is reachable over HTTPS, and this project just calls it via `OLLAMA_URL`.

**Free option (no budget, no VPS, no card):** [`huggingface-space/`](huggingface-space/)
is a ready-to-push Docker Space for Hugging Face's free CPU tier — see
"1. Ollama server" below. Any other always-on host works too (VPS, home
server behind a reverse proxy, managed Ollama host); Ollama has no
built-in auth, so whatever you use should sit behind HTTPS with some form
of access control.

## WhatsApp sending

Not implemented in this version (skipped per initial setup). Email delivery
is fully wired up via Resend. To add WhatsApp later, the cleanest path is
Twilio's WhatsApp API — add a `sendItineraryWhatsApp` function alongside
`netlify/functions/lib/email.js` and call it next to the email send in
`netlify/functions/process-itineraries-background.js`.

## How it works

1. `process-itineraries-background` runs on a schedule (hourly by default,
   see `netlify.toml`). The `-background` suffix is required by Netlify to
   get the longer (15 min) execution limit — **background functions require
   a paid Netlify plan**; on the free tier, either downgrade to synchronous
   (drop the suffix, accept the 10s/26s limit) or use a fast/GPU-backed
   Ollama server and set `MAX_ROWS_PER_RUN=1`.
2. It reads all rows from the sheet where the **Status** column is blank.
3. For each row (up to `MAX_ROWS_PER_RUN` per invocation), it:
   - Builds a prompt from the row and asks Ollama for a structured JSON
     itinerary.
   - Renders that JSON into a PDF with `pdfkit`.
   - Emails the PDF to the traveler via Resend.
   - Writes `Sent` (or `Error: ...`) back into the Status column, with a
     timestamp, so the row is never processed twice.

Because processing is gated on the Status column, re-running the function
(manually or via schedule) is safe — it only ever touches pending rows.

## Google Sheet schema

Matches the live "Trip Inquiries" sheet, row 1 = headers, data starts on
row 2, sheet/tab name `Sheet1`:

| A | B | C | D | E | F | G | H | I | J | K | L | M | N | O | P |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Timestamp | Name | Phone | Email | Destination | Travel Date | Duration | Time Preference | Trip Type | Adults | Children | Budget | Departing From | Notes | Status | Sent At |

**Status** and **Sent At** (O, P) are owned by the function — leave them
blank for new inquiry rows, it fills them in and never touches columns
A-N.

## Setup (Apps Script — the active path)

### 1. Ollama server (free: Hugging Face Space)

1. Create a free [Hugging Face](https://huggingface.co) account (no card
   required).
2. Create a new **Space**: SDK = **Docker**, and set **Visibility to
   Private** — this matters, since it's what stands in for auth (Ollama
   itself has none). A public Space would let anyone who finds the URL
   use your compute.
3. Push this repo's [`huggingface-space/`](huggingface-space/) folder
   contents (`Dockerfile` + `README.md`) as the Space's repo contents:
   ```bash
   git clone https://huggingface.co/spaces/<your-username>/<space-name> hf-space
   cp huggingface-space/* hf-space/
   cd hf-space
   git add -A && git commit -m "Ollama space" && git push
   ```
4. Wait for the build to finish (Space → **Logs**) — it pulls `llama3`
   (~4.7GB) during the build, so the first build takes a while. Once
   built, the Space stays warm-ish; free-tier Spaces do sleep after a
   period of inactivity and take a short while to wake on the next
   request, so expect an occasional slow first call.
5. Generate an access token: [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) →
   **New token** → Read access is enough. This is what authenticates
   calls to your private Space.
6. Your Space's URL is `https://<your-username>-<space-name>.hf.space`
   — that's `OLLAMA_URL`. The token from step 5 is `HF_TOKEN` (see
   Script Properties below).

Free CPU tier, no GPU — expect similar generation times to local testing
(1-4 min per itinerary). Swap `llama3` for a different model by editing
`huggingface-space/Dockerfile`'s `ollama pull` line (and the
`OLLAMA_MODEL` script property to match) if you want something smaller/
faster or larger/better.

Any other always-on HTTPS-reachable Ollama host (VPS, home server +
reverse proxy) works too — `HF_TOKEN` is only relevant if you go the
private-Space route; leave it unset otherwise and add your own auth
scheme in front of Ollama if the host is exposed publicly.

### 2. Install the script

1. Open the "Trip Inquiries" Google Sheet, signed in as an account with
   **edit** access (the sheet owner, or anyone it's shared with as Editor).
2. **Extensions → Apps Script**. Delete the default `Code.gs` boilerplate
   and paste in the contents of [`apps-script/Code.gs`](apps-script/Code.gs)
   from this repo.
3. In the editor's left sidebar, **Project Settings** (gear icon) → **Script
   Properties** → add:
   - `OLLAMA_URL` = your Ollama endpoint (e.g. the HF Space URL from step 1)
   - `OLLAMA_MODEL` = `llama3` (optional, this is the default)
   - `HF_TOKEN` = your Hugging Face access token (only needed if `OLLAMA_URL`
     points at a private HF Space, per step 1)
4. Select `createHourlyTrigger` in the function dropdown at the top and
   click **Run**. The first run will prompt an OAuth consent screen (Apps
   Script needs permission to read/write the sheet, create/delete temp
   Docs, and send email) — approve it. This both authorizes the script and
   sets up the hourly trigger.

### 3. Test it

With `createHourlyTrigger` already run once, select `processPendingTrips`
in the function dropdown and click **Run** to process any pending rows
immediately rather than waiting for the next hourly tick. Check
**Executions** in the left sidebar for logs if something fails.

Because processing is gated on the **Status** column (see schema above),
re-running is always safe — it only ever touches rows with a blank Status.

## WhatsApp sending

Not implemented (skipped per initial setup). To add it, call Twilio's
WhatsApp API via `UrlFetchApp.fetch(...)` inside `processPendingTrips` in
`apps-script/Code.gs`, next to the `sendItineraryEmail` call.

## Adjusting the schedule

Edit `createHourlyTrigger()` in `apps-script/Code.gs` (e.g.
`.everyHours(1)` → `.everyMinutes(30)` or `.everyDays(1)`), then re-run it
from the Apps Script editor to replace the existing trigger.

---

## Reference: the original Netlify implementation (not deployed)

`netlify/functions/process-itineraries-background.js` and its `lib/`
helpers implement the identical logic for Netlify Functions instead of
Apps Script. It's blocked on Google Sheets access (see "Why Apps Script
instead of Netlify" above) but is otherwise complete and tested locally.
If the org policy blocking service account keys is ever lifted, or the
project moves to a personal Google account, this path still works:

1. **Google Sheets access**: enable the Sheets API in Google Cloud
   Console, create a service account + JSON key, share the sheet with the
   service account's email as Editor, set `GOOGLE_SERVICE_ACCOUNT_JSON`
   (the full key JSON) and `GOOGLE_SHEET_ID`.
2. **Ollama server**: same as above, set `OLLAMA_URL` (and `HF_TOKEN` if
   using a private HF Space).
3. **Resend (email)**: sign up at [resend.com](https://resend.com), verify
   a sending domain, set `RESEND_API_KEY` and `EMAIL_FROM`.
4. **Local dev**: `npm install`, `cp .env.example .env` (fill in values),
   `netlify dev`, then `netlify functions:invoke process-itineraries-background`.
5. **Deploy**: Netlify dashboard → Add new site → Import an existing
   project → this repo. No build command needed, publish directory
   `public` (already set in `netlify.toml`). Add every var from
   `.env.example` under Environment Variables, then deploy — the schedule
   in `netlify.toml` picks it up automatically.

Adjust its schedule via the `schedule` value in `netlify.toml` (cron syntax
or shorthand like `@hourly`, `@daily`).
