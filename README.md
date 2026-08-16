# Itinerary Agent

Reads trip requests from a Google Sheet, generates a day-by-day itinerary
using an Ollama LLM, renders it as a PDF, and emails it to the traveler.
Runs as a scheduled Netlify **background** function.

**Tested locally** against `llama3:8b`: a single 4-day itinerary took
~3.5 minutes end-to-end (Ollama generation dominates). Budget for several
minutes per trip — this is why the function uses Netlify's background-function
timeout (15 min) instead of the standard 10s/26s limit, and why
`MAX_ROWS_PER_RUN` defaults to a conservative 3.

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

Row 1 = headers, data starts on row 2, sheet/tab name `Sheet1`:

| A    | B     | C           | D          | E        | F         | G      | H           | I      | J       |
|------|-------|-------------|------------|----------|-----------|--------|-------------|--------|---------|
| Name | Email | Destination | Start Date | End Date | Travelers | Budget | Preferences | Status | Sent At |

Leave **Status** and **Sent At** blank for new rows — the function fills
them in.

## Setup

### 1. Google Sheets access

1. In [Google Cloud Console](https://console.cloud.google.com/), create (or
   reuse) a project, enable the **Google Sheets API**.
2. Create a **Service Account**, then create a JSON key for it and download
   it.
3. Open your Google Sheet and **share** it with the service account's email
   address (found in the JSON key as `client_email`), with Editor access.
4. Copy the full contents of the JSON key file — you'll paste it as
   `GOOGLE_SERVICE_ACCOUNT_JSON` (as a single line) in Netlify env vars.
5. Copy the spreadsheet ID from its URL for `GOOGLE_SHEET_ID`:
   `https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit`

### 2. Ollama server

Stand up Ollama somewhere reachable over HTTPS, e.g. a small VPS:

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llama3
ollama serve
```

Put it behind a reverse proxy (nginx/Caddy) with HTTPS and, ideally, some
form of access control (IP allowlist or an auth proxy) since Ollama has no
built-in auth. Set `OLLAMA_URL` to that HTTPS endpoint.

### 3. Resend (email)

1. Sign up at [resend.com](https://resend.com), verify a sending domain (or
   use their test domain during development).
2. Create an API key → `RESEND_API_KEY`.
3. Set `EMAIL_FROM` to a verified sender on that domain.

### 4. Local development

```bash
npm install
cp .env.example .env   # fill in real values
netlify dev
```

Trigger the function locally:

```bash
netlify functions:invoke process-itineraries-background
```

### 5. Deploy to Netlify

1. Push this repo to GitHub (already done if you're reading this from the
   repo).
2. In the [Netlify dashboard](https://app.netlify.com), **Add new site →
   Import an existing project**, pick this repo.
3. Build settings: no build command needed, publish directory `public`
   (already set in `netlify.toml`).
4. Under **Site configuration → Environment variables**, add every variable
   from `.env.example` with real values.
5. Deploy. The scheduled function will start running hourly per
   `netlify.toml`; check **Functions** in the Netlify dashboard for logs and
   manual invocation.

## Adjusting the schedule

Edit the `schedule` value in `netlify.toml` (cron syntax or Netlify's
shorthand like `@hourly`, `@daily`).
