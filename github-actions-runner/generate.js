// Runs inside GitHub Actions (see .github/workflows/generate-itineraries.yml)
// against a freshly-installed local Ollama on the runner. Fetches pending
// trips from the Apps Script Web App (Webhook.gs), generates an itinerary
// for each via local Ollama, and POSTs the result back so the Web App can
// build the PDF and send the email — no Google auth needed here at all.

const os = require("os");
const { setGlobalDispatcher, Agent } = require("undici");

// Node's built-in fetch (undici under the hood) silently kills any request
// that takes longer than 5 minutes (its default headersTimeout/bodyTimeout),
// throwing a generic "fetch failed" with no indication that's what happened.
// The richer, multi-pointer itinerary prompt - now generating a full day
// entry per day of the trip, not capped at ~3 - can legitimately take Ollama
// well over 15 minutes on a CPU-only runner for long, multi-week trips.
// Raise the ceiling well above that (comfortably under the job's own
// 60-minute timeout) so a slow-but-working generation isn't cut off
// mid-response.
setGlobalDispatcher(new Agent({ headersTimeout: 25 * 60 * 1000, bodyTimeout: 25 * 60 * 1000 }));

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

// Must match (or be >=) MAX_ROWS_PER_FETCH in apps-script/Webhook.gs, and
// the OLLAMA_NUM_PARALLEL the workflow sets when starting the server - all
// three need to agree for concurrent generations to actually help instead
// of just queuing behind each other.
const MAX_CONCURRENT = 2;

// Split available CPU cores across however many generations might run at
// once, instead of letting every concurrent request fight for all of them.
const OLLAMA_THREADS = Math.max(1, Math.floor(os.cpus().length / MAX_CONCURRENT));

// Generous ceiling on output length - purely a guard against a pathological
// runaway generation eating the whole job timeout, not a target. Sized with
// headroom for long, multi-week trips now that the model is explicitly
// required to produce one entry per day of the stated duration (see
// resolveDayCount/buildPrompt) - does not trade off detail.
const MAX_OUTPUT_TOKENS = 8192;

if (!WEBHOOK_URL || !WEBHOOK_SECRET) {
  console.error("WEBHOOK_URL and WEBHOOK_SECRET env vars must be set");
  process.exit(1);
}

// Retries a flaky async operation once after a short pause - covers
// transient network blips (on either the Ollama call or the webhook call)
// without masking a genuinely broken request.
async function withRetry(fn, label) {
  try {
    return await fn();
  } catch (err) {
    console.error(`${label} failed once (${err.message}), retrying...`);
    await new Promise((r) => setTimeout(r, 5000));
    return fn();
  }
}

// Pulls a concrete day count out of free-text Duration values like "5 Days",
// "1 Week", or "2 weeks" so the model gets an unambiguous target instead of
// having to infer it - without this, models tend to default to a short
// (often 3-day) itinerary regardless of the trip's actual length.
function resolveDayCount(durationStr) {
  if (!durationStr) return null;
  const str = String(durationStr).toLowerCase();
  const weekMatch = str.match(/(\d+)\s*week/);
  if (weekMatch) return parseInt(weekMatch[1], 10) * 7;
  const dayMatch = str.match(/(\d+)/);
  if (dayMatch) return parseInt(dayMatch[1], 10);
  return null;
}

function buildPrompt(trip) {
  const dayCount = resolveDayCount(trip.duration);
  const dayCountInstruction = dayCount
    ? `CRITICAL: This trip is ${dayCount} day(s) long. The "days" array MUST contain exactly ${dayCount} entries — one per day, in order. Do not stop early, do not truncate, and do not default to a shorter itinerary no matter how long that makes your response.`
    : `CRITICAL: The "days" array must cover the ENTIRE trip Duration stated above, with exactly one entry per day (e.g. "1 week" = 7 day entries, "10 Days" = 10 day entries). Never default to a short itinerary regardless of how long the trip is. Only fall back to a 3-day itinerary if Duration is genuinely missing or unreadable.`;

  return `You are a senior travel concierge writing a premium, detailed itinerary for a paying client — not a generic outline. Create a detailed day-by-day travel itinerary based on this trip request:

Traveler: ${trip.name || "N/A"}
Destination: ${trip.destination}
Departing From: ${trip.departingFrom || "N/A"}
Travel Date: ${trip.travelDate || "N/A"}
Duration: ${trip.duration || "N/A"}
Preferred Time to Travel: ${trip.timePreference || "N/A"}
Trip Type: ${trip.tripType || "N/A"}
Adults: ${trip.adults || "N/A"}
Children: ${trip.children || "N/A"}
Budget: ${trip.budget || "N/A"}
Additional Notes: ${trip.notes || "N/A"}

${dayCountInstruction}

For EVERY activity, give real, specific value — never a single generic sentence. Each activity needs 2-4 short pointer-style details covering: what it is and why it's worth doing (with a specific place/landmark name), a practical tip (best time to go, approximate cost, or how to book), and where useful, a nearby recommendation (food, viewpoint, etc). Use real place names for the destination, not placeholders.

Respond with ONLY valid JSON, no markdown fences, no commentary, matching exactly this structure:
{
  "destination": "string",
  "summary": "3-4 sentence trip overview, specific and evocative, not generic",
  "days": [
    {
      "date": "YYYY-MM-DD or Day 1 style label if dates are unknown",
      "title": "short theme for the day",
      "activities": [
        {
          "time": "Morning|Afternoon|Evening",
          "title": "short, specific activity name (e.g. a real place or landmark)",
          "details": ["pointer 1", "pointer 2", "pointer 3"]
        }
      ]
    }
  ],
  "tips": ["practical tip 1", "practical tip 2", "practical tip 3"]
}

Each activity's "details" array must contain 2 to 4 short pointer strings — never just one line. Include at least 2 activities per day.`;
}

async function callWebhook(action, payload) {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, secret: WEBHOOK_SECRET, ...payload }),
  });
  if (!res.ok) {
    throw new Error(`Webhook call failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function generateItinerary(trip) {
  const res = await fetch(`${OLLAMA_URL.replace(/\/$/, "")}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: buildPrompt(trip),
      format: "json",
      stream: false,
      options: {
        num_predict: MAX_OUTPUT_TOKENS,
        num_thread: OLLAMA_THREADS,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Ollama request failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  let itinerary;
  try {
    itinerary = JSON.parse(data.response);
  } catch (err) {
    throw new Error(`Ollama returned non-JSON response: ${String(data.response).slice(0, 200)}`);
  }

  if (!itinerary.days || !Array.isArray(itinerary.days)) {
    throw new Error("Ollama response missing a valid 'days' array");
  }

  return itinerary;
}

(async () => {
  console.log("Fetching pending trips from the webhook...");
  const pendingRes = await callWebhook("getPending", {});
  if (pendingRes.error) {
    console.error("getPending failed:", pendingRes.error);
    process.exit(1);
  }

  const trips = pendingRes.trips || [];
  console.log(`Got ${trips.length} pending trip(s). Processing up to ${MAX_CONCURRENT} at a time.`);

  async function processTrip(trip) {
    console.log(`Row ${trip.rowNumber}: generating itinerary for "${trip.destination}"...`);
    const startedAt = Date.now();
    try {
      const itinerary = await withRetry(() => generateItinerary(trip), `Ollama generation for row ${trip.rowNumber}`);
      console.log(`Row ${trip.rowNumber}: generated in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      const result = await withRetry(
        () => callWebhook("submitResult", { rowNumber: trip.rowNumber, itinerary }),
        `submitResult for row ${trip.rowNumber}`
      );
      console.log(`Row ${trip.rowNumber}: ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`Row ${trip.rowNumber} failed:`, err.message);
      await withRetry(
        () => callWebhook("submitResult", { rowNumber: trip.rowNumber, error: err.message }),
        `error report for row ${trip.rowNumber}`
      ).catch((e) => console.error("Also failed to report the error back to the webhook after retry:", e));
    }
  }

  // Run concurrently (bounded by MAX_CONCURRENT, which matches how many
  // rows getPending ever returns) instead of one-at-a-time, so a batch of
  // pending trips doesn't wait on each other sequentially.
  await Promise.all(trips.map(processTrip));

  console.log("Done.");
})();
