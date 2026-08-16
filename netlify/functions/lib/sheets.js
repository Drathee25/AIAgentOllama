const { google } = require("googleapis");

// Expected sheet columns (row 1 = header, data starts row 2):
// A: Name  B: Email  C: Destination  D: Start Date  E: End Date
// F: Travelers  G: Budget  H: Preferences  I: Status  J: Sent At
const RANGE = "Sheet1!A2:J";
const STATUS_COL = "I";
const SENT_AT_COL = "J";

function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON env var is not set");
  }
  const credentials = JSON.parse(raw);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function getSheetsClient() {
  const auth = getAuth();
  return google.sheets({ version: "v4", auth });
}

// Returns unprocessed rows (Status column blank) as objects, each carrying
// its 1-indexed sheet row number so results can be written back later.
async function getPendingTrips() {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId) {
    throw new Error("GOOGLE_SHEET_ID env var is not set");
  }
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: RANGE,
  });
  const rows = res.data.values || [];

  return rows
    .map((row, i) => ({
      rowNumber: i + 2, // offset for header row + 1-index
      name: row[0] || "",
      email: row[1] || "",
      destination: row[2] || "",
      startDate: row[3] || "",
      endDate: row[4] || "",
      travelers: row[5] || "",
      budget: row[6] || "",
      preferences: row[7] || "",
      status: row[8] || "",
    }))
    .filter((trip) => trip.status.trim() === "" && trip.email && trip.destination);
}

async function updateTripStatus(rowNumber, status) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `Sheet1!${STATUS_COL}${rowNumber}:${SENT_AT_COL}${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[status, new Date().toISOString()]],
    },
  });
}

module.exports = { getPendingTrips, updateTripStatus };
