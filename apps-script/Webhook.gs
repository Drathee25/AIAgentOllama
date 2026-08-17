// Standalone Apps Script Web App — NOT bound to the Trip Inquiries sheet,
// deliberately kept as a separate project so it can never collide with (or
// risk breaking) the sheet's existing form-intake doPost webhook.
//
// This is the bridge for the free async Ollama pattern: GitHub Actions runs
// Ollama on its own hourly cron (see .github/workflows/), fetches pending
// trips from this Web App, generates itineraries, and POSTs results back
// here — this Web App does the actual Google-side work (PDF, email, status)
// since it has native Google auth and GitHub Actions doesn't.
//
// One-time setup:
//   1. Project Settings (gear icon) > Script Properties:
//        SHEET_ID       = the Trip Inquiries spreadsheet ID (from its URL)
//        WEBHOOK_SECRET = a long random string — also set as the
//                         WEBHOOK_SECRET GitHub Actions repo secret
//   2. Deploy > New deployment > type "Web app" > Execute as: Me,
//      Who has access: Anyone. Authorize when prompted.
//   3. Copy the deployment URL into the WEBHOOK_URL GitHub Actions
//      repo secret.

const SHEET_NAME = "Sheet1";
const START_ROW = 2;
const START_COL = 1; // A
const NUM_COLS = 16; // A..P
const STATUS_COL = 15; // O
const SENT_AT_COL = 16; // P
const MAX_ROWS_PER_FETCH = 3;

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse_({ error: "Invalid JSON body" });
  }

  const expectedSecret = PropertiesService.getScriptProperties().getProperty("WEBHOOK_SECRET");
  if (!expectedSecret || body.secret !== expectedSecret) {
    return jsonResponse_({ error: "Unauthorized" });
  }

  if (body.action === "getPending") {
    return jsonResponse_({ trips: getAndClaimPendingTrips_() });
  }

  if (body.action === "submitResult") {
    return jsonResponse_(submitResult_(body));
  }

  return jsonResponse_({ error: "Unknown action" });
}

function getSheet_() {
  const sheetId = PropertiesService.getScriptProperties().getProperty("SHEET_ID");
  if (!sheetId) throw new Error("SHEET_ID script property is not set");
  return SpreadsheetApp.openById(sheetId).getSheetByName(SHEET_NAME);
}

function rowToTrip_(row, rowNumber) {
  return {
    rowNumber: rowNumber,
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
}

// Returns up to MAX_ROWS_PER_FETCH pending trips (Status blank) and
// immediately marks them "Processing" so an overlapping run doesn't also
// pick them up.
function getAndClaimPendingTrips_() {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < START_ROW) return [];

  const range = sheet.getRange(START_ROW, START_COL, lastRow - START_ROW + 1, NUM_COLS);
  const values = range.getValues();

  const claimed = [];
  for (let i = 0; i < values.length && claimed.length < MAX_ROWS_PER_FETCH; i++) {
    const rowNumber = START_ROW + i;
    const trip = rowToTrip_(values[i], rowNumber);
    if (String(trip.status).trim() !== "" || !trip.email || !trip.destination) continue;

    claimed.push(trip);
    sheet.getRange(rowNumber, STATUS_COL).setValue("Processing");
  }

  return claimed;
}

function submitResult_(body) {
  const rowNumber = body.rowNumber;
  if (!rowNumber) return { error: "Missing rowNumber" };

  const sheet = getSheet_();

  if (body.error) {
    sheet.getRange(rowNumber, STATUS_COL).setValue(("Error: " + body.error).slice(0, 500));
    sheet.getRange(rowNumber, SENT_AT_COL).setValue(new Date());
    return { status: "recorded-error" };
  }

  const itinerary = body.itinerary;
  if (!itinerary || !itinerary.days) {
    return { error: "Missing itinerary in payload" };
  }

  const row = sheet.getRange(rowNumber, START_COL, 1, NUM_COLS).getValues()[0];
  const trip = rowToTrip_(row, rowNumber);

  try {
    const pdfBlob = buildItineraryPdf(trip, itinerary);
    sendItineraryEmail(trip, itinerary, pdfBlob);
    sheet.getRange(rowNumber, STATUS_COL).setValue("Sent");
    sheet.getRange(rowNumber, SENT_AT_COL).setValue(new Date());
    return { status: "sent" };
  } catch (err) {
    sheet.getRange(rowNumber, STATUS_COL).setValue(("Error: " + err.message).slice(0, 500));
    sheet.getRange(rowNumber, SENT_AT_COL).setValue(new Date());
    return { error: err.message };
  }
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

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
