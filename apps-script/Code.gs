// Bound to the "Trip Inquiries" sheet. Reads pending rows (Status blank),
// generates an itinerary via a remote Ollama server, builds a PDF, and
// emails it to the traveler. Mirrors the Netlify function's logic, but runs
// entirely inside Google's own auth (no service account / JSON key needed).
//
// One-time setup:
//   1. Extensions > Apps Script properties (gear icon) > Script Properties:
//        OLLAMA_URL   = https://your-space.hf.space  (a private HF Space, see huggingface-space/)
//        OLLAMA_MODEL = llama3   (optional, defaults to llama3)
//        HF_TOKEN     = hf_xxxxxxxx  (a Hugging Face access token with access
//                       to the private Space above — required if OLLAMA_URL
//                       points at one, since that's what keeps the endpoint
//                       from being publicly callable by anyone else)
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
  const hfToken = props.getProperty("HF_TOKEN");
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
      const itinerary = generateItinerary(trip, ollamaUrl, ollamaModel, hfToken);
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
    "You are a senior travel concierge writing a premium, detailed itinerary for a paying client — not a generic outline. Create a detailed day-by-day travel itinerary based on this trip request:\n\n" +
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
    "For EVERY activity, give real, specific value — never a single generic sentence. Each activity needs 2-4 short pointer-style details covering: what it is and why it's worth doing (with a specific place/landmark name), a practical tip (best time to go, approximate cost, or how to book), and where useful, a nearby recommendation (food, viewpoint, etc). Use real place names for the destination, not placeholders.\n\n" +
    "Respond with ONLY valid JSON, no markdown fences, no commentary, matching exactly this structure:\n" +
    "{\n" +
    '  "destination": "string",\n' +
    '  "summary": "3-4 sentence trip overview, specific and evocative, not generic",\n' +
    '  "days": [\n' +
    "    {\n" +
    '      "date": "YYYY-MM-DD or Day 1 style label if dates are unknown",\n' +
    '      "title": "short theme for the day",\n' +
    '      "activities": [\n' +
    "        {\n" +
    '          "time": "Morning|Afternoon|Evening",\n' +
    '          "title": "short, specific activity name (e.g. a real place or landmark)",\n' +
    '          "details": ["pointer 1", "pointer 2", "pointer 3"]\n' +
    "        }\n" +
    "      ]\n" +
    "    }\n" +
    "  ],\n" +
    '  "tips": ["practical tip 1", "practical tip 2", "practical tip 3"]\n' +
    "}\n\n" +
    'Each activity\'s "details" array must contain 2 to 4 short pointer strings — never just one line. Include at least 2 activities per day.'
  );
}

function generateItinerary(trip, ollamaUrl, model, hfToken) {
  const headers = { "Content-Type": "application/json" };
  if (hfToken) headers["Authorization"] = "Bearer " + hfToken;

  const res = UrlFetchApp.fetch(ollamaUrl.replace(/\/$/, "") + "/api/generate", {
    method: "post",
    contentType: "application/json",
    headers: headers,
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

// 1TripWiser brand palette, sampled from the logo.
const BRAND = {
  navy: "#16213E",
  gold: "#F5B921",
  teal: "#1B8CA8",
  crimson: "#D9455B",
  forest: "#2E6E45",
  charcoal: "#333333",
  slate: "#6B7280",
  cardBg: "#F7F5EF",
  ruleLight: "#E5E1D3",
  white: "#FFFFFF",
};

// Base64-encoded PNG of the 1TripWiser logo, embedded directly in the
// script (Script Properties cap out at 9KB, far too small for an image).
// Replace with the real logo's base64 — see apps-script/logo-base64.txt.
const LOGO_BASE64 = "";

function buildItineraryPdf(trip, itinerary) {
  const doc = DocumentApp.create("tmp-itinerary-" + Utilities.getUuid());
  const body = doc.getBody();
  body.setMarginTop(40).setMarginBottom(40).setMarginLeft(54).setMarginRight(54);

  appendLogo_(body);
  appendRule_(body, BRAND.gold, 2);

  const title = body.appendParagraph((itinerary.destination || trip.destination || "").toUpperCase());
  title.setAlignment(DocumentApp.HorizontalAlignment.CENTER).setSpacingBefore(16).setSpacingAfter(4);
  title.editAsText().setBold(true).setFontSize(24).setForegroundColor(BRAND.navy);

  const metaParts = [];
  if (trip.name) metaParts.push("Prepared for " + trip.name);
  const dateBit = [trip.travelDate, trip.duration].filter(Boolean).join(" · ");
  if (dateBit) metaParts.push(dateBit);
  if (trip.departingFrom) metaParts.push("Departing from " + trip.departingFrom);
  if (metaParts.length) {
    const meta = body.appendParagraph(metaParts.join("   |   "));
    meta.setAlignment(DocumentApp.HorizontalAlignment.CENTER).setSpacingAfter(14);
    meta.editAsText().setForegroundColor(BRAND.slate).setFontSize(10).setItalic(true);
  }

  if (itinerary.summary) {
    appendCard_(body, itinerary.summary, BRAND.cardBg, BRAND.charcoal);
  }

  (itinerary.days || []).forEach((day, idx) => {
    appendDayBanner_(body, day.date || "Day " + (idx + 1), day.title, idx);
    (day.activities || []).forEach((activity) => {
      appendActivity_(body, activity);
    });
  });

  if (itinerary.tips && itinerary.tips.length) {
    const tipsHeader = body.appendParagraph("TRAVEL TIPS");
    tipsHeader.setSpacingBefore(20).setSpacingAfter(6);
    tipsHeader.editAsText().setBold(true).setForegroundColor(BRAND.teal).setFontSize(12);

    itinerary.tips.forEach((tip) => {
      const li = body.appendListItem(tip);
      li.setGlyphType(DocumentApp.GlyphType.BULLET).setSpacingAfter(3);
      li.editAsText().setForegroundColor(BRAND.charcoal).setFontSize(10.5);
    });
  }

  appendRule_(body, BRAND.ruleLight, 1);
  const footer = body.appendParagraph("Crafted with care by 1TripWiser  ·  www.1tripwiser.com");
  footer.setAlignment(DocumentApp.HorizontalAlignment.CENTER).setSpacingBefore(10);
  footer.editAsText().setForegroundColor(BRAND.slate).setFontSize(8.5).setItalic(true);

  doc.saveAndClose();
  const fileId = doc.getId();
  const pdfBlob = DriveApp.getFileById(fileId).getAs("application/pdf");
  pdfBlob.setName((itinerary.destination || trip.destination).replace(/[^a-z0-9]+/gi, "-") + "-itinerary.pdf");
  DriveApp.getFileById(fileId).setTrashed(true); // clean up the temp Doc
  return pdfBlob;
}

function appendLogo_(body) {
  if (!LOGO_BASE64) return;
  try {
    const blob = Utilities.newBlob(Utilities.base64Decode(LOGO_BASE64), "image/png", "logo.png");
    const firstPara = body.getParagraphs()[0];
    firstPara.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
    const img = firstPara.appendInlineImage(blob);
    const width = 84;
    const ratio = img.getHeight() / img.getWidth();
    img.setWidth(width);
    img.setHeight(Math.round(width * ratio));
  } catch (err) {
    // Ignore - render without the logo.
  }
}

function appendRule_(body, colorHex, heightPt) {
  const table = body.appendTable([[""]]);
  table.setBorderWidth(0);
  const cell = table.getRow(0).getCell(0);
  cell.setBackgroundColor(colorHex);
  cell.setPaddingTop(0).setPaddingBottom(0).setPaddingLeft(0).setPaddingRight(0);
  const para = cell.getChild(0).asParagraph();
  para.setSpacingBefore(0).setSpacingAfter(0);
  para.editAsText().setFontSize(Math.max(heightPt, 1));
}

function appendCard_(body, text, bgColor, textColor) {
  const table = body.appendTable([[text]]);
  table.setBorderWidth(0);
  const cell = table.getRow(0).getCell(0);
  cell.setBackgroundColor(bgColor);
  cell.setPaddingTop(12).setPaddingBottom(12).setPaddingLeft(14).setPaddingRight(14);
  cell.getChild(0).asParagraph().editAsText().setForegroundColor(textColor).setFontSize(11);
}

function appendDayBanner_(body, dateLabel, dayTitle, idx) {
  const spacer = body.appendParagraph("");
  spacer.setSpacingBefore(idx === 0 ? 6 : 20).setSpacingAfter(0);

  const label = dateLabel + (dayTitle ? "   ·   " + dayTitle : "");
  const table = body.appendTable([[label]]);
  table.setBorderWidth(0);
  const cell = table.getRow(0).getCell(0);
  cell.setBackgroundColor(BRAND.navy);
  cell.setPaddingTop(8).setPaddingBottom(8).setPaddingLeft(14).setPaddingRight(14);
  cell.getChild(0).asParagraph().editAsText().setBold(true).setForegroundColor(BRAND.white).setFontSize(12.5);
}

function appendActivity_(body, activity) {
  const timeLabel = activity.time ? String(activity.time).toUpperCase() : "";
  const titleText = activity.title || activity.description || "";
  const headingText = (timeLabel ? timeLabel + "  " : "") + titleText;

  const para = body.appendParagraph(headingText);
  para.setSpacingBefore(10).setSpacingAfter(2);
  const t = para.editAsText();
  t.setBold(true).setForegroundColor(BRAND.navy).setFontSize(11.5);
  if (timeLabel) {
    t.setForegroundColor(0, timeLabel.length - 1, BRAND.gold);
  }

  const details = activity.details && activity.details.length ? activity.details : activity.description ? [activity.description] : [];
  details.forEach((detail) => {
    const li = body.appendListItem(detail);
    li.setGlyphType(DocumentApp.GlyphType.BULLET).setSpacingAfter(2);
    li.editAsText().setForegroundColor(BRAND.charcoal).setFontSize(10.5);
  });
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
