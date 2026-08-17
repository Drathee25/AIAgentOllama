const { google } = require("googleapis");

// Matches the real "Trip Inquiries" sheet (row 1 = header, data starts row 2):
// A:Timestamp B:Name C:Phone D:Email E:Destination F:Travel Date G:Duration
// H:Time Preference I:Trip Type J:Adults K:Children L:Budget M:Departing From
// N:Notes O:Status P:Sent At
const RANGE = "Sheet1!A2:P";
const STATUS_COL = "O";
const SENT_AT_COL = "P";

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
      timestamp: row[0] || "",
      name: row[1] || "",
      phone: row[2] || "",
      email: row[3] || "",
      destination: row[4] || "",
      travelDate: row[5] || "",
      duration: row[6] || "",
      timePreference: row[7] || "",
      tripType: row[8] || "",
      adults: row[9] || "",
      children: row[10] || "",
      budget: row[11] || "",
      departingFrom: row[12] || "",
      notes: row[13] || "",
      status: row[14] || "",
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
