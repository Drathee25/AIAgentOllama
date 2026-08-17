// Runs inside GitHub Actions (see .github/workflows/generate-itineraries.yml)
// against a freshly-installed local Ollama on the runner. Fetches pending
// trips from the Apps Script Web App (Webhook.gs), generates an itinerary
// for each via local Ollama, and POSTs the result back so the Web App can
// build the PDF and send the email — no Google auth needed here at all.

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

if (!WEBHOOK_URL || !WEBHOOK_SECRET) {
  console.error("WEBHOOK_URL and WEBHOOK_SECRET env vars must be set");
  process.exit(1);
}

function buildPrompt(trip) {
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
  console.log(`Got ${trips.length} pending trip(s).`);

  for (const trip of trips) {
    console.log(`Row ${trip.rowNumber}: generating itinerary for "${trip.destination}"...`);
    try {
      const itinerary = await generateItinerary(trip);
      const result = await callWebhook("submitResult", { rowNumber: trip.rowNumber, itinerary });
      console.log(`Row ${trip.rowNumber}: ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`Row ${trip.rowNumber} failed:`, err.message);
      await callWebhook("submitResult", { rowNumber: trip.rowNumber, error: err.message }).catch((e) =>
        console.error("Also failed to report the error back to the webhook:", e)
      );
    }
  }

  console.log("Done.");
})();
