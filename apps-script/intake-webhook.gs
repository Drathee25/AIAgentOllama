// This is the PRE-EXISTING form-intake script bound to the "Trip Inquiries"
// sheet (deployed as its own Web App, receiving POSTs from the 1TripWiser
// website). It was not written as part of this project. It's captured here
// only so the additions we made — triggering the itinerary workflow
// immediately on a new submission, and emailing a new-lead notification —
// are tracked in git.
//
// Everything above the `triggerItineraryWorkflow_()` call, and the
// `triggerItineraryWorkflow_` / `sendNewLeadNotification_` functions
// themselves, are the only changes from the original. Do not otherwise
// modify this file without checking what else depends on it.
//
// One-time setup for the new additions:
//   Project Settings > Script Properties on THIS project:
//     GITHUB_TOKEN = a fine-grained GitHub PAT scoped to just this repo,
//                    with "Contents: Read and write" permission (needed
//                    for the repository_dispatch API). If that's not
//                    enough, also try "Actions: Read and write".
//     GITHUB_REPO  = Drathee25/AIAgentOllama
//
//   For SENDER_EMAIL below to actually send "from" that address (rather
//   than Gmail silently sending as this script's own account), it must be
//   added and verified as a "Send mail as" alias in this account's Gmail
//   settings (Settings > Accounts and Import > Send mail as). Until then,
//   sendNewLeadNotification_ automatically falls back to the default
//   sending identity, so the notification still goes out either way.
var SENDER_EMAIL = '1tripwiser@gmail.com';
var LEAD_BCC = 'anuranjana@advivifymediagroup.com';

function doPost(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var data = JSON.parse(e.postData.contents);

  var headers = ['Timestamp', 'Name', 'Phone', 'Email', 'Destination', 'Travel Date', 'Duration', 'Time Preference', 'Trip Type', 'Adults', 'Children', 'Budget', 'Departing From', 'Notes'];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
  }

  sheet.appendRow([
    new Date(),
    data.name || '',
    data.phone || '',
    data.email || '',
    data.destination || '',
    data.date || '',
    data.duration || '',
    data.time_pref || '',
    data.trip_type || '',
    data.adults || '',
    data.children || '',
    data.budget || '',
    data.departing || '',
    data.notes || ''
  ]);

  triggerItineraryWorkflow_();
  sendNewLeadNotification_(data);

  return ContentService.createTextOutput(JSON.stringify({ status: 'ok' })).setMimeType(ContentService.MimeType.JSON);
}

// Pings GitHub to run the itinerary-generation workflow immediately instead
// of waiting for a schedule. Deliberately never throws - a failure here
// (bad token, GitHub outage, etc.) must never break the actual form
// intake above, which real customers depend on.
function triggerItineraryWorkflow_() {
  try {
    var props = PropertiesService.getScriptProperties();
    var token = props.getProperty('GITHUB_TOKEN');
    var repo = props.getProperty('GITHUB_REPO');
    if (!token || !repo) return;

    UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/dispatches', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json'
      },
      payload: JSON.stringify({ event_type: 'new-trip' }),
      muteHttpExceptions: true
    });
  } catch (err) {
    console.error('Failed to trigger itinerary workflow: ' + err);
  }
}

// Emails SENDER_EMAIL (bcc'd to LEAD_BCC) the moment a new trip inquiry
// lands, so the team sees every lead immediately instead of only after the
// itinerary is generated and sent. Deliberately never throws, same as
// triggerItineraryWorkflow_ above - a notification failure must never
// break the actual form intake.
function sendNewLeadNotification_(data) {
  try {
    var subject = 'New Trip Inquiry: ' + (data.destination || 'Unknown destination') + (data.name ? ' - ' + data.name : '');
    var body = [
      'A new trip inquiry just came in:',
      '',
      'Name: ' + (data.name || 'N/A'),
      'Phone: ' + (data.phone || 'N/A'),
      'Email: ' + (data.email || 'N/A'),
      'Destination: ' + (data.destination || 'N/A'),
      'Travel Date: ' + (data.date || 'N/A'),
      'Duration: ' + (data.duration || 'N/A'),
      'Time Preference: ' + (data.time_pref || 'N/A'),
      'Trip Type: ' + (data.trip_type || 'N/A'),
      'Adults: ' + (data.adults || 'N/A'),
      'Children: ' + (data.children || 'N/A'),
      'Budget: ' + (data.budget || 'N/A'),
      'Departing From: ' + (data.departing || 'N/A'),
      'Notes: ' + (data.notes || 'N/A')
    ].join('\n');

    var options = { bcc: LEAD_BCC, from: SENDER_EMAIL, name: '1TripWiser' };
    try {
      GmailApp.sendEmail(SENDER_EMAIL, subject, body, options);
    } catch (err) {
      // SENDER_EMAIL isn't verified as a "Send mail as" alias yet - fall
      // back to the default sending identity so the notification still
      // goes out (the BCC still applies).
      delete options.from;
      GmailApp.sendEmail(SENDER_EMAIL, subject, body, options);
    }
  } catch (err) {
    console.error('Failed to send new-lead notification: ' + err);
  }
}
