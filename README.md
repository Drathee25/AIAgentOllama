# Itinerary Agent

Reads trip requests from a Google Sheet, generates a day-by-day itinerary
using an Ollama LLM, renders it as a PDF, and emails it to the traveler —
built for zero ongoing cost.

**Active implementation: GitHub Actions + Apps Script**, split across three
pieces:
1. [`.github/workflows/generate-itineraries.yml`](.github/workflows/generate-itineraries.yml) +
   [`github-actions-runner/generate.js`](github-actions-runner/generate.js) —
   runs hourly on GitHub's free Actions runners (unlimited/free since this
   repo is public), installs Ollama fresh each run, and generates itineraries.
2. [`apps-script/Webhook.gs`](apps-script/Webhook.gs) — a standalone Apps
   Script Web App (deliberately **not** bound to the sheet, so it can never
   collide with the sheet's existing form-intake webhook) that GitHub
   Actions calls to fetch pending trips and submit results. This is where
   the PDF gets built and the email gets sent, since it has native Google
   auth and GitHub Actions doesn't.
3. [`apps-script/Code.gs`](apps-script/Code.gs) — the sheet-bound script
   with a `processPendingTrips`/`createHourlyTrigger` fallback path that
   calls Ollama directly instead of going through GitHub Actions. Useful if
   you ever have a real always-on `OLLAMA_URL` (a VPS, etc.) and want to
   skip the GitHub Actions hop — see "Alternative: direct Apps Script →
   Ollama" further down. **Not currently scheduled** (superseded by the
   GitHub Actions path).

The original Netlify function (`netlify/functions/`) is kept in the repo
but is **not** deployed/active; documented further down for reference.

## Why this path (and not the simpler ones we tried first)

- **Netlify** needed a Google service account (downloadable JSON key) for
  Sheets access. The Google Cloud org it was created under enforces
  `iam.disableServiceAccountKeyCreation` — blocks all key creation
  org-wide, not fixable without an Org Policy Administrator there.
- **Plain Google Apps Script calling Ollama directly** works great, but
  needs an always-on, publicly-reachable Ollama host. No budget was
  available for a VPS, and even normally-free options didn't pan out:
  Oracle Cloud's free-forever tier requires a card for verification (not
  approved), and Hugging Face's Docker Spaces (which can run a real
  persistent process, unlike serverless platforms) turned out to require a
  paid plan even on personal accounts — Static-only Spaces are free, but
  those can't run Ollama.
- **GitHub Actions** is genuinely free with no card, since Actions minutes
  are unlimited for public repos, and its runners are real (if ephemeral)
  VMs that can run a real process like `ollama serve`. The trade-off:
  Actions runners aren't reachable *from* the internet (no inbound
  networking), so Apps Script can't call out to one directly the way it
  would call a normal `OLLAMA_URL`. Instead, GitHub Actions runs on its own
  cron and calls *out* to the `Webhook.gs` Web App — direction reversed
  from every other setup in this repo, but it's what makes free compute
  workable here.

**Tested locally** (via the equivalent Netlify/Apps Script code path
against `llama3:8b`): a single 4-day itinerary took ~1-4 minutes end-to-end
(Ollama generation dominates). Budget similarly in GitHub Actions — each
run installs Ollama and pulls the model fresh (cached between runs via
`actions/cache` to avoid re-downloading every time), then generates up to
3 itineraries.

## Ollama hosting

Neither Netlify Functions nor a bound Google Apps Script trigger can run
Ollama itself — both are short-lived/serverless execution models, and
Ollama needs a persistent process with multi-GB model weights loaded in
memory. GitHub Actions runners solve this differently: they're temporary
but real VMs, so `ollama serve` runs fine for the duration of each job —
see "Why this path" above for why the architecture is shaped the way it is.

## How it works

1. `.github/workflows/generate-itineraries.yml` runs hourly (also
   manually triggerable from the repo's Actions tab). It installs Ollama
   fresh, restores the cached model (or pulls it if not cached), and
   starts `ollama serve` locally on the runner.
2. `github-actions-runner/generate.js` POSTs `{action: "getPending"}` to
   the `Webhook.gs` Web App, which reads the sheet, returns up to 3 rows
   where **Status** is blank, and immediately marks them `Processing` (so
   an overlapping run can't double-claim them).
3. For each trip, it builds a prompt and asks the local Ollama for a
   structured JSON itinerary, then POSTs `{action: "submitResult", ...}`
   back to the Web App.
4. `Webhook.gs` renders the itinerary into a PDF (Google Docs → PDF
   export), emails it via `MailApp`, and writes `Sent` (or `Error: ...`)
   plus a timestamp into the Status/Sent At columns.

Because claiming happens immediately on fetch and results are gated on
`rowNumber`, re-running (manually or via schedule) is safe. One known gap:
if a GitHub Actions run crashes *after* claiming a row but *before*
submitting a result, that row is stuck at `Processing` with no automatic
retry — manually clear its Status cell to re-queue it.

## WhatsApp sending

Not implemented in this version (skipped per initial setup). Email
delivery is fully wired up via `MailApp` in `Webhook.gs`. To add WhatsApp
later, the cleanest path is Twilio's WhatsApp API — call it via
`UrlFetchApp.fetch(...)` in `submitResult_` in `apps-script/Webhook.gs`,
next to the `sendItineraryEmail` call.

## Google Sheet schema

Matches the live "Trip Inquiries" sheet, row 1 = headers, data starts on
row 2, sheet/tab name `Sheet1`:

| A | B | C | D | E | F | G | H | I | J | K | L | M | N | O | P |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Timestamp | Name | Phone | Email | Destination | Travel Date | Duration | Time Preference | Trip Type | Adults | Children | Budget | Departing From | Notes | Status | Sent At |

**Status** and **Sent At** (O, P) are owned by the function — leave them
blank for new inquiry rows, it fills them in and never touches columns
A-N.

## Setup (GitHub Actions + Webhook — the active path)

### 1. Deploy the Webhook Web App

1. Go to [script.google.com](https://script.google.com) → **New project**.
   This must be a **standalone** project (not opened via Extensions from
   the sheet) — that's what keeps it separate from the sheet's existing
   form-intake script.
2. Delete the default boilerplate, paste in the contents of
   [`apps-script/Webhook.gs`](apps-script/Webhook.gs).
3. **Project Settings** (gear icon) → **Script Properties** → add:
   - `SHEET_ID` = the Trip Inquiries spreadsheet ID (from its URL:
     `https://docs.google.com/spreadsheets/d/<THIS_PART>/edit`)
   - `WEBHOOK_SECRET` = a long random string you generate yourself (e.g.
     `openssl rand -hex 32`) — write it down, you'll need it again for the
     GitHub secret in step 3 below.
4. **Deploy → New deployment** → type **Web app** → Execute as **Me**,
   Who has access **Anyone**. Click **Deploy**, approve the OAuth consent
   screen when prompted (needs Sheets, Drive, and Gmail access).
5. Copy the **Web app URL** it gives you — that's `WEBHOOK_URL`.

### 2. Add GitHub Actions secrets

In this repo: **Settings → Secrets and variables → Actions → New
repository secret**, add:
- `WEBHOOK_URL` = the Web app URL from step 1.5
- `WEBHOOK_SECRET` = the same random string from step 1.3

### 3. Test it

**Actions** tab → **Generate Itineraries** workflow → **Run workflow** to
trigger it immediately instead of waiting for the next hourly tick. Watch
the run's logs; it'll print how many pending trips it found and the result
for each. Because claiming happens on fetch and the Status column gates
everything, re-running (manually or via the hourly schedule) is always
safe.

## Adjusting the schedule

Edit the `cron` value in
[`.github/workflows/generate-itineraries.yml`](.github/workflows/generate-itineraries.yml)
(standard 5-field cron syntax, e.g. `*/30 * * * *` for every 30 minutes).

## Alternative: direct Apps Script → Ollama (no GitHub Actions hop)

If you get a real always-on, publicly-reachable Ollama host later (a VPS,
etc.), you can skip the GitHub Actions/Webhook indirection entirely and
have the sheet-bound script call Ollama directly — this is what
`apps-script/Code.gs`'s `processPendingTrips`/`createHourlyTrigger`
already implement, just not currently scheduled:

1. Open the "Trip Inquiries" Google Sheet (signed in with edit access) →
   **Extensions → Apps Script**, confirm `apps-script/Code.gs`'s contents
   are already there as a second file (`ItineraryAgent.gs` in this
   project, alongside the sheet's original intake `Code.gs` — leave that
   one untouched).
2. **Project Settings → Script Properties** → set `OLLAMA_URL` (and
   `OLLAMA_MODEL`, `HF_TOKEN` if relevant) to your host.
3. Select `createHourlyTrigger` in the function dropdown, click **Run**,
   approve the OAuth prompt. This schedules `processPendingTrips` hourly.
4. If the GitHub Actions workflow is also still enabled, disable it
   (Actions tab → workflow → **⋯ → Disable workflow**) to avoid both
   paths claiming the same rows.

---

## Reference: the original Netlify implementation (not deployed)

`netlify/functions/process-itineraries-background.js` and its `lib/`
helpers implement the identical logic for Netlify Functions instead of
Apps Script. It's blocked on Google Sheets access (see "Why this path"
above) but is otherwise complete and tested locally. If the org policy
blocking service account keys is ever lifted, or the project moves to a
personal Google account, this path still works:

1. **Google Sheets access**: enable the Sheets API in Google Cloud
   Console, create a service account + JSON key, share the sheet with the
   service account's email as Editor, set `GOOGLE_SERVICE_ACCOUNT_JSON`
   (the full key JSON) and `GOOGLE_SHEET_ID`.
2. **Ollama server**: set `OLLAMA_URL` to any always-on host you have (a
   VPS, etc. — see "Why this path" above for what was tried and ruled out
   on the free-tier front; `huggingface-space/` is kept in the repo but
   turned out to require a paid HF plan, see its README).
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
