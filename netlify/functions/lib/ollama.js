// Calls a remote Ollama server (netlify functions can't host Ollama itself,
// so OLLAMA_URL must point at a reachable instance, e.g. a VPS or tunnel).

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

async function generateItinerary(trip) {
  const ollamaUrl = process.env.OLLAMA_URL;
  if (!ollamaUrl) {
    throw new Error("OLLAMA_URL env var is not set");
  }
  const model = process.env.OLLAMA_MODEL || "llama3";
  const hfToken = process.env.HF_TOKEN;

  const headers = { "Content-Type": "application/json" };
  if (hfToken) headers["Authorization"] = `Bearer ${hfToken}`;

  const res = await fetch(`${ollamaUrl.replace(/\/$/, "")}/api/generate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
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
    throw new Error(`Ollama returned non-JSON response: ${data.response?.slice(0, 200)}`);
  }

  if (!itinerary.days || !Array.isArray(itinerary.days)) {
    throw new Error("Ollama response missing a valid 'days' array");
  }

  return itinerary;
}

module.exports = { generateItinerary };
