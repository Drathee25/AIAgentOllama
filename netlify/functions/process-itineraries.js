const { getPendingTrips, updateTripStatus } = require("./lib/sheets");
const { generateItinerary } = require("./lib/ollama");
const { buildItineraryPdf } = require("./lib/pdf");
const { sendItineraryEmail } = require("./lib/email");

// Cap rows processed per invocation to stay within the function's execution
// time limit (Ollama generation + PDF + email can take a while per row).
const MAX_ROWS_PER_RUN = Number(process.env.MAX_ROWS_PER_RUN || 5);

exports.handler = async () => {
  const results = [];

  let trips;
  try {
    trips = await getPendingTrips();
  } catch (err) {
    console.error("Failed to read Google Sheet:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }

  const batch = trips.slice(0, MAX_ROWS_PER_RUN);

  for (const trip of batch) {
    try {
      const itinerary = await generateItinerary(trip);
      const pdfBuffer = await buildItineraryPdf(trip, itinerary);
      const fileName = `${(itinerary.destination || trip.destination).replace(/[^a-z0-9]+/gi, "-")}-itinerary.pdf`;

      await sendItineraryEmail({
        to: trip.email,
        name: trip.name,
        destination: itinerary.destination || trip.destination,
        pdfBuffer,
        fileName,
      });

      await updateTripStatus(trip.rowNumber, "Sent");
      results.push({ row: trip.rowNumber, email: trip.email, status: "sent" });
    } catch (err) {
      console.error(`Row ${trip.rowNumber} failed:`, err);
      await updateTripStatus(trip.rowNumber, `Error: ${err.message}`.slice(0, 500)).catch((e) =>
        console.error("Also failed to write error status:", e)
      );
      results.push({ row: trip.rowNumber, email: trip.email, status: "error", error: err.message });
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      processed: results.length,
      remainingPending: trips.length - batch.length,
      results,
    }),
  };
};
