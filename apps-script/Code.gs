// Bound to the "Trip Inquiries" sheet. Reads pending rows (Status blank),
// generates an itinerary via a remote Ollama server, builds a PDF, and
// emails it to the traveler. Mirrors the Netlify function's logic, but runs
// entirely inside Google's own auth (no service account / JSON key needed).
//
// One-time setup:
//   1. Extensions > Apps Script properties (gear icon) > Script Properties:
//        OLLAMA_URL   = https://your-public-ollama-host.example.com
//        OLLAMA_MODEL = llama3   (optional, defaults to llama3)
//   2. Run createHourlyTrigger() once from the editor to schedule it.

const SHEET_NAME = "Sheet1";
const START_ROW = 2;
const START_COL = 1; // A
const NUM_COLS = 16; // A..P
const STATUS_COL = 15; // O
const SENT_AT_COL = 16; // P

function processPendingTrips() {
  const props = PropertiesService.getScriptProperties();
  const ollamaUrl = props.getProperty("OLLAMA_URL");
  const ollamaModel = props.getProperty("OLLAMA_MODEL") || "llama3";
  if (!ollamaUrl) {
    throw new Error("Set OLLAMA_URL in Script Properties (Project Settings) first.");
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < START_ROW) return;

  const range = sheet.getRange(START_ROW, START_COL, lastRow - START_ROW + 1, NUM_COLS);
  const values = range.getValues();

  values.forEach((row, i) => {
    const rowNumber = START_ROW + i;
    const trip = {
      timestamp: row[0],
      name: row[1],
      phone: row[2],
      email: row[3],
      destination: row[4],
      travelDate: row[5],
      duration: row[6],
      timePreference: row[7],
      tripType: row[8],
      adults: row[9],
      children: row[10],
      budget: row[11],
      departingFrom: row[12],
      notes: row[13],
      status: row[14],
    };
    if (String(trip.status).trim() !== "" || !trip.email || !trip.destination) return;

    try {
      const itinerary = generateItinerary(trip, ollamaUrl, ollamaModel);
      const pdfBlob = buildItineraryPdf(trip, itinerary);
      sendItineraryEmail(trip, itinerary, pdfBlob);
      sheet.getRange(rowNumber, STATUS_COL).setValue("Sent");
      sheet.getRange(rowNumber, SENT_AT_COL).setValue(new Date());
    } catch (err) {
      sheet.getRange(rowNumber, STATUS_COL).setValue(("Error: " + err.message).slice(0, 500));
      sheet.getRange(rowNumber, SENT_AT_COL).setValue(new Date());
    }
  });
}

function buildPrompt_(trip) {
  return (
    "You are a travel itinerary planner. Create a detailed day-by-day travel itinerary based on this trip request:\n\n" +
    "Traveler: " + (trip.name || "N/A") + "\n" +
    "Destination: " + trip.destination + "\n" +
    "Departing From: " + (trip.departingFrom || "N/A") + "\n" +
    "Travel Date: " + (trip.travelDate || "N/A") + "\n" +
    "Duration: " + (trip.duration || "N/A") + "\n" +
    "Preferred Time to Travel: " + (trip.timePreference || "N/A") + "\n" +
    "Trip Type: " + (trip.tripType || "N/A") + "\n" +
    "Adults: " + (trip.adults || "N/A") + "\n" +
    "Children: " + (trip.children || "N/A") + "\n" +
    "Budget: " + (trip.budget || "N/A") + "\n" +
    "Additional Notes: " + (trip.notes || "N/A") + "\n\n" +
    "Respond with ONLY valid JSON, no markdown fences, no commentary, matching exactly this structure:\n" +
    "{\n" +
    '  "destination": "string",\n' +
    '  "summary": "2-3 sentence trip overview",\n' +
    '  "days": [\n' +
    "    {\n" +
    '      "date": "YYYY-MM-DD or Day 1 style label if dates are unknown",\n' +
    '      "title": "short theme for the day",\n' +
    '      "activities": [\n' +
    '        { "time": "Morning|Afternoon|Evening", "description": "activity description" }\n' +
    "      ]\n" +
    "    }\n" +
    "  ],\n" +
    '  "tips": ["practical tip 1", "practical tip 2"]\n' +
    "}"
  );
}

function generateItinerary(trip, ollamaUrl, model) {
  const res = UrlFetchApp.fetch(ollamaUrl.replace(/\/$/, "") + "/api/generate", {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({
      model: model,
      prompt: buildPrompt_(trip),
      format: "json",
      stream: false,
    }),
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() !== 200) {
    throw new Error("Ollama request failed: " + res.getResponseCode() + " " + res.getContentText());
  }

  const data = JSON.parse(res.getContentText());
  let itinerary;
  try {
    itinerary = JSON.parse(data.response);
  } catch (e) {
    throw new Error("Ollama returned non-JSON response: " + String(data.response).slice(0, 200));
  }

  if (!itinerary.days || !Array.isArray(itinerary.days)) {
    throw new Error("Ollama response missing a valid 'days' array");
  }

  return itinerary;
}

function buildItineraryPdf(trip, itinerary) {
  const doc = DocumentApp.create("tmp-itinerary-" + Utilities.getUuid());
  const body = doc.getBody();
  body.setMarginTop(50).setMarginBottom(50).setMarginLeft(50).setMarginRight(50);

  body
    .appendParagraph(itinerary.destination || trip.destination)
    .setHeading(DocumentApp.ParagraphHeading.TITLE)
    .setAlignment(DocumentApp.HorizontalAlignment.CENTER);

  const subtitleParts = [];
  if (trip.name) subtitleParts.push("Prepared for " + trip.name);
  const dateBit = [trip.travelDate, trip.duration].filter(Boolean).join(" · ");
  if (dateBit) subtitleParts.push(dateBit);
  if (subtitleParts.length) {
    body
      .appendParagraph(subtitleParts.join("  |  "))
      .setAlignment(DocumentApp.HorizontalAlignment.CENTER)
      .setForegroundColor("#555555");
  }

  if (itinerary.summary) {
    body.appendParagraph(itinerary.summary);
  }

  (itinerary.days || []).forEach((day, idx) => {
    const heading = (day.date || "Day " + (idx + 1)) + (day.title ? " — " + day.title : "");
    body
      .appendParagraph(heading)
      .setHeading(DocumentApp.ParagraphHeading.HEADING2)
      .setForegroundColor("#009951");
    (day.activities || []).forEach((activity) => {
      const text = (activity.time ? activity.time + ": " : "") + activity.description;
      body.appendListItem(text).setGlyphType(DocumentApp.GlyphType.BULLET);
    });
  });

  if (itinerary.tips && itinerary.tips.length) {
    body
      .appendParagraph("Travel Tips")
      .setHeading(DocumentApp.ParagraphHeading.HEADING2)
      .setForegroundColor("#009951");
    itinerary.tips.forEach((tip) => {
      body.appendListItem(tip).setGlyphType(DocumentApp.GlyphType.BULLET);
    });
  }

  doc.saveAndClose();
  const fileId = doc.getId();
  const pdfBlob = DriveApp.getFileById(fileId).getAs("application/pdf");
  pdfBlob.setName((itinerary.destination || trip.destination).replace(/[^a-z0-9]+/gi, "-") + "-itinerary.pdf");
  DriveApp.getFileById(fileId).setTrashed(true); // clean up the temp Doc
  return pdfBlob;
}

function sendItineraryEmail(trip, itinerary, pdfBlob) {
  const destination = itinerary.destination || trip.destination;
  MailApp.sendEmail({
    to: trip.email,
    subject: "Your " + destination + " Itinerary",
    body: "Hi " + (trip.name || "there") + ",\n\nYour itinerary for " + destination + " is attached as a PDF. Have a great trip!\n",
    attachments: [pdfBlob],
  });
}

// Run once manually from the editor to schedule hourly processing.
function createHourlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "processPendingTrips") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("processPendingTrips").timeBased().everyHours(1).create();
}
