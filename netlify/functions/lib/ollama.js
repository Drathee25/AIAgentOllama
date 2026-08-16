// Calls a remote Ollama server (netlify functions can't host Ollama itself,
// so OLLAMA_URL must point at a reachable instance, e.g. a VPS or tunnel).

function buildPrompt(trip) {
  return `You are a travel itinerary planner. Create a detailed day-by-day travel itinerary based on this trip request:

Traveler: ${trip.name || "N/A"}
Destination: ${trip.destination}
Start Date: ${trip.startDate || "N/A"}
End Date: ${trip.endDate || "N/A"}
Number of Travelers: ${trip.travelers || "N/A"}
Budget: ${trip.budget || "N/A"}
Interests/Preferences: ${trip.preferences || "N/A"}

Respond with ONLY valid JSON, no markdown fences, no commentary, matching exactly this structure:
{
  "destination": "string",
  "summary": "2-3 sentence trip overview",
  "days": [
    {
      "date": "YYYY-MM-DD or Day 1 style label if dates are unknown",
      "title": "short theme for the day",
      "activities": [
        { "time": "Morning|Afternoon|Evening", "description": "activity description" }
      ]
    }
  ],
  "tips": ["practical tip 1", "practical tip 2"]
}`;
}

async function generateItinerary(trip) {
  const ollamaUrl = process.env.OLLAMA_URL;
  if (!ollamaUrl) {
    throw new Error("OLLAMA_URL env var is not set");
  }
  const model = process.env.OLLAMA_MODEL || "llama3";

  const res = await fetch(`${ollamaUrl.replace(/\/$/, "")}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
