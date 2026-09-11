# Itinerary Agent

Reads trip requests from a Google Sheet, generates a day-by-day itinerary
using an Ollama LLM, renders it as a PDF, and emails it to the traveler —
built for zero ongoing cost.

**Active implementation: GitHub Actions + Apps Script**, split across four
pieces:
1. [`apps-script/intake-webhook.gs`](apps-script/intake-webhook.gs) — the
   sheet's **pre-existing** form-intake script (receives POSTs from the
   1TripWiser website, appends the row). The only change made to it: right
   after appending, it now pings GitHub's `repository_dispatch` API to
   fire the workflow **immediately**, instead of waiting for any schedule.
   Wrapped so a failure here (bad token, GitHub outage) can never break
   the actual form submission.
2. [`.github/workflows/generate-itineraries.yml`](.github/workflows/generate-itineraries.yml) +
   [`github-actions-runner/generate.js`](github-actions-runner/generate.js) —
   triggered by that dispatch (or manually, for testing) on GitHub's free
   Actions runners (unlimited/free since this repo is public). Installs
   Ollama fresh each run and generates itineraries. **No polling, no
   schedule** — it only ever runs in response to a real new submission.
3. [`apps-script/Webhook.gs`](apps-script/Webhook.gs) — a standalone Apps
   Script Web App (deliberately **not** bound to the sheet, so it can never
   collide with the intake script above) that GitHub Actions calls to
   fetch pending trips and submit results. This is where the PDF gets
   built and the email gets sent, since it has native Google auth and
   GitHub Actions doesn't.
4. [`apps-script/Code.gs`](apps-script/Code.gs) — a `processPendingTrips`/
   `createHourlyTrigger` fallback path that calls Ollama directly instead
   of going through GitHub Actions. Useful if you ever have a real
   always-on `OLLAMA_URL` (a VPS, etc.) and want to skip the GitHub
   Actions hop — see "Alternative: direct Apps Script → Ollama" further
   down. **Not currently scheduled** (superseded by the instant-trigger
   path above).

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
  would call a normal `OLLAMA_URL`. Instead the direction is reversed from
  every other setup in this repo: the intake webhook calls *out* to
  GitHub's `repository_dispatch` API the instant a new row lands, which
  starts the workflow, which then calls *out* to the `Webhook.gs` Web App.
  No polling anywhere in the chain.

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

1. A visitor submits the trip inquiry form on the 1TripWiser website →
   POSTs to `intake-webhook.gs`'s `doPost`, which appends the row to the
   sheet (unchanged, pre-existing behavior).
2. Right after appending, it calls GitHub's `repository_dispatch` API
   (`triggerItineraryWorkflow_()`) to fire `generate-itineraries.yml`
   **immediately** — no polling, no waiting for a scheduled tick.
3. The workflow installs Ollama fresh, restores the cached model (or
   pulls it if not cached), and starts `ollama serve` locally on the
   runner.
4. `github-actions-runner/generate.js` POSTs `{action: "getPending"}` to
   the `Webhook.gs` Web App, which reads the sheet, returns up to 3 rows
   where **Status** is blank, and immediately marks them `Processing` (so
   an overlapping run can't double-claim them).
5. For each trip, it builds a prompt and asks the local Ollama for a
   structured JSON itinerary, renders the branded PDF with headless Chrome
   ([`github-actions-runner/pdf.js`](github-actions-runner/pdf.js)), then
   POSTs `{action: "submitResult", itinerary, pdfBase64, ...}` back to the
   Web App.
6. `Webhook.gs` emails that PDF, and writes `Sent` (or `Error: ...`) plus a
   timestamp into the Status/Sent At columns. If the runner couldn't render
   a PDF, it falls back to building one itself (Google Docs → PDF export).

**PDF design.** `pdf.js` follows the approved "TripWiser Itinerary" design
file: Playfair Display / Lora / Jost (embedded from `@fontsource`, no
network needed), a running `1TRIPWISER` header and contact footer on every
page, and fixed pagination — page 1 is the overview (headline, trip facts,
traveller details, trip team, trip at a glance), day-by-day starts on a
new page with every day block kept whole, and the tips / next steps /
closing banner follow without being split. It's rendered in Chrome rather
than Google Docs because Docs can't keep blocks from splitting across
pages. To preview a layout change locally, run `renderItineraryPdf(trip,
itinerary)` from `pdf.js` (needs Node 22+ and `npm install` in
`github-actions-runner/`). `PDF_PAPER=a4` switches from US Letter to A4.

**Email design.** `buildItineraryEmailHtml_` in `Webhook.gs` follows the
approved "TripWiser Itinerary Email" design (600px table layout, Georgia /
Arial for email-client safety): headline, trip facts, main button with the
PDF's page count and size, a first-three-days preview, the Team 1TripWiser
card, and Sign up / Blog / Tribe rows where the design had sample packages.
Set the optional `ITINERARY_FOLDER_ID` Script Property to make the main
button a real "Download the full itinerary (PDF)" link. This saves each PDF
to that Drive folder with view-by-link sharing, so only enable it if that's
acceptable for the traveller details inside.

Because claiming happens immediately on fetch and results are gated on
`rowNumber`, re-running (manually via the Actions tab, or from another
dispatch) is safe. One known gap: if a GitHub Actions run crashes *after*
claiming a row but *before* submitting a result, that row is stuck at
`Processing` with no automatic retry — manually clear its Status cell to
re-queue it. Similarly, if the dispatch call in step 2 itself fails (bad
token, GitHub outage), that row just sits pending with nothing watching
for it until the next successful dispatch happens to sweep it up too —
there's no time-based safety net by design, per the "only run when there's
a real new entry" requirement.

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

### 3. Wire up the instant trigger

1. Create a GitHub **fine-grained personal access token**:
   [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new) →
   scope it to **only** the `Drathee25/AIAgentOllama` repository →
   under Repository permissions, grant **Contents: Read and write** (this
   is what the `repository_dispatch` endpoint requires). If GitHub still
   rejects the dispatch call with that scope, also try adding **Actions:
   Read and write**.
2. Open the **Trip Inquiries** sheet → **Extensions → Apps Script** — this
   opens the project containing the sheet's original intake `Code.gs`.
   Update that file to match [`apps-script/intake-webhook.gs`](apps-script/intake-webhook.gs)
   (only the `triggerItineraryWorkflow_()` call and function are new —
   everything else is unchanged from what was already there).
3. In that same project's **Project Settings → Script Properties**, add:
   - `GITHUB_TOKEN` = the token from step 1
   - `GITHUB_REPO` = `Drathee25/AIAgentOllama`
4. Save. No redeploy needed if the Web App deployment is on the "Head"
   version; if it's pinned to a specific version, deploy a new version
   (**Deploy → Manage deployments → Edit → Version: New version**).

### 4. Test it

Submit a real inquiry through the website, or send a test POST directly
to the intake webhook's URL with a JSON body matching what the form
sends. Within moments, check the repo's **Actions** tab — a new run
should appear automatically, with no one having clicked "Run workflow".
You can also trigger a run manually from there for debugging (**Generate
Itineraries** → **Run workflow**), which is unaffected by the change.

Because claiming happens on fetch and the Status column gates everything,
overlapping runs are always safe.

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
4. Remove the `triggerItineraryWorkflow_()` call from
   `intake-webhook.gs`'s `doPost` (or just leave `GITHUB_TOKEN`/
   `GITHUB_REPO` unset there — the function no-ops without them) so both
   paths don't end up claiming the same rows.

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
