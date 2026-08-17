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

Netlify Functions are short-lived, stateless, serverless functions — they
cannot run Ollama itself (no persistent process, no GPU/local model weights).
You need an Ollama instance running somewhere reachable over HTTPS (a VPS,
a home server behind a reverse proxy/tunnel, a managed Ollama host, etc.),
and this project just calls it over HTTP via `OLLAMA_URL`.

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

### 1. Ollama server

Stand up Ollama somewhere reachable over HTTPS, e.g. a small VPS — Apps
Script calls out over the public internet, so `localhost` will not work:

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llama3
ollama serve
```

Put it behind a reverse proxy (nginx/Caddy) with HTTPS and, ideally, some
form of access control (IP allowlist or an auth proxy) since Ollama has no
built-in auth.

### 2. Install the script

1. Open the "Trip Inquiries" Google Sheet, signed in as an account with
   **edit** access (the sheet owner, or anyone it's shared with as Editor).
2. **Extensions → Apps Script**. Delete the default `Code.gs` boilerplate
   and paste in the contents of [`apps-script/Code.gs`](apps-script/Code.gs)
   from this repo.
3. In the editor's left sidebar, **Project Settings** (gear icon) → **Script
   Properties** → add:
   - `OLLAMA_URL` = your public HTTPS Ollama endpoint
   - `OLLAMA_MODEL` = `llama3` (optional, this is the default)
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
2. **Ollama server**: same as above, set `OLLAMA_URL`.
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
