// Standalone Apps Script Web App — NOT bound to the Trip Inquiries sheet,
// deliberately kept as a separate project so it can never collide with (or
// risk breaking) the sheet's existing form-intake doPost webhook.
//
// This is the bridge for the free event-driven Ollama pattern: the sheet's
// intake webhook fires this project's counterpart GitHub Actions workflow
// the instant a new row lands (see .github/workflows/), which fetches
// pending trips from this Web App, generates itineraries, and POSTs
// results back here — this Web App does the actual Google-side work (PDF,
// email, status) since it has native Google auth and GitHub Actions doesn't.
//
// One-time setup:
//   1. Project Settings (gear icon) > Script Properties:
//        SHEET_ID       = the Trip Inquiries spreadsheet ID (from its URL)
//        WEBHOOK_SECRET = a long random string — also set as the
//                         WEBHOOK_SECRET GitHub Actions repo secret
//   2. Set LOGO_BASE64 below to the 1TripWiser logo's base64 PNG data
//      (see apps-script/logo-base64.txt in the repo) for the branded PDF
//      header — safe to leave blank, the PDF just renders without a logo.
//   3. Deploy > New deployment > type "Web app" > Execute as: Me,
//      Who has access: Anyone. Authorize when prompted.
//   4. Copy the deployment URL into the WEBHOOK_URL GitHub Actions
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
// Replace the string below with the real logo's base64 — see
// apps-script/logo-base64.txt in the repo for the generated value.
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

// Puts the logo in the body's existing first (empty) paragraph, centered.
// Silently does nothing if no logo has been configured, or if anything
// about the image is malformed — a logo problem must never break the
// actual itinerary email.
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

// A thin solid-color horizontal rule, built from a single-cell borderless
// table since Docs has no native colored <hr>.
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

// A soft "card" block (light background, padding) for the trip summary.
function appendCard_(body, text, bgColor, textColor) {
  const table = body.appendTable([[text]]);
  table.setBorderWidth(0);
  const cell = table.getRow(0).getCell(0);
  cell.setBackgroundColor(bgColor);
  cell.setPaddingTop(12).setPaddingBottom(12).setPaddingLeft(14).setPaddingRight(14);
  cell.getChild(0).asParagraph().editAsText().setForegroundColor(textColor).setFontSize(11);
}

// A solid navy banner for each day's date/title.
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

// One activity: a bold time-of-day + title line, followed by 2-4 bulleted
// detail pointers. Falls back to the older {time, description} shape if
// "details"/"title" aren't present, so a slightly-off model response still
// renders something reasonable instead of breaking.
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

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
